# Parmelia DeFi — Diseño y decisiones

> Arquitectura DeFi de Parmelia sobre Arbitrum. El **Módulo 2 (swaps internos)
> está implementado** (ver §2); los módulos 1, 3, 4 y 5 quedan aquí diseñados
> para implementarse por etapas. Fecha: junio 2026.

---

## 0. Decisiones clave (resumen ejecutivo)

| Decisión | Elección | Por qué |
|---|---|---|
| Red | **Arbitrum One** (prod) / **Arbitrum Sepolia** (test) | Gas bajo, RIP-7212, liquidez DeFi madura. Sin multichain core. |
| Infra de swaps | **Universal Router** (v4-compatible) como única superficie de ejecución | Soporta rutas v3 **y** v4 con un solo contrato auditado; trae `PAY_PORTION`/`TAKE_PORTION` para fees de integrador sin contrato propio. |
| v4 vs v3 | **v4-first con fallback v3, decidido por cotización real** | Se sondean ambos on-chain y gana el mejor output. v4 ahorra gas en pares ETH (native currency, sin wrap); v3 aún tiene la liquidez más profunda en pares WBTC. "v4-only" sería irresponsable: dejaría pares sin la mejor ejecución. |
| Cotización | **On-chain quoters (QuoterV2 + V4Quoter) vía eth_call** | Sin API keys, sin dependencia de servicios externos, verificable. |
| BTC wrapper | **WBTC** (`0x2f2a...5B0f`, 8 dec) | Liquidez BTC más profunda de Arbitrum (pools v3 WBTC/WETH y WBTC/USDC). cbBTC creció (~25% del mercado) pero su liquidez en Arbitrum sigue menor; tBTC es más descentralizado pero fino. Config-driven: cambiar a cbBTC = editar una entrada en `shared/networks.ts`. Sin WBTC canónico en Sepolia → par BTC es mainnet-only. |
| Permit2 con smart accounts | **Approvals exactos batcheados, NO firma EIP-712** | Ver §2.3. |
| Fees | **`TAKE_PORTION`/`PAY_PORTION` del router** (sin contrato wrapper) | Atómico, auditable on-chain, cero gas extra de contrato propio. |

---

## 1. Módulo 1 — Depósitos cross-chain hacia Arbitrum (diseño)

**Objetivo:** fondos en Ethereum/Base/Optimism/Arbitrum → smart account del
usuario en Arbitrum, terminando en USDC, ETH o WBTC.

**Infraestructura recomendada (en orden):**
1. **Circle CCTP v2** para USDC→USDC: quema/acuña USDC nativo, sin slippage de
   bridge, fees mínimas. Es la ruta por defecto cuando origen y destino son USDC.
2. **Across Protocol** para ETH y tokens no-USDC: intents con relayers, llegada
   en segundos-minutos, API de quotes pública (`/suggested-fees`). Maduro y
   barato para L2→L2.
3. **Uniswap Trading API (cross-chain, ERC-7683)** como evolución una vez que el
   producto lo justifique — unifica swap+bridge en un intent, pero agrega una
   dependencia de API con key.

**No** construir bridge propio. **No** custodiar fondos en tránsito.

**Flujo:** el usuario conecta una wallet externa (wagmi/walletconnect — única
pantalla donde existe una wallet externa), Parmelia cotiza
(CCTP/Across), muestra *recibirás ≈ X, fee del puente, fee Parmelia, tiempo
estimado*, el usuario firma **en su wallet externa** (no con passkey: los fondos
están fuera), y el backend trackea hasta acreditar en la smart account.

**Estados:** `quoted → pending_signature → submitted → bridging → completed`
con ramas `failed / expired / refunded / needs_support`.

**Persistencia:** tabla nueva `crosschain_operations` (NO reutilizar
`pending_payments`: semántica distinta — multi-paso, multi-chain, horas de vida
vs 10 min). Columnas: `op_id, uid, source_chain_id, source_tx_hash, provider
(cctp|across), token_in, token_out, amount_in, amount_out_expected, recipient
(smart account), status, status_detail, created_at, updated_at, completed_at`.
Reconciliación por **Cloudflare Cron Trigger** que consulta attestations de
CCTP / estado de Across y actualiza el estado (el Worker no puede "esperar").

**Por qué no se implementó aún:** requiere wagmi en el cliente (dependencia
nueva), atestaciones asíncronas (cron + webhooks) y pruebas con fondos reales
en 4 redes. Es el siguiente módulo natural tras estabilizar swaps.

---

## 2. Módulo 2 — Swaps internos (IMPLEMENTADO)

### 2.1 Arquitectura

```
client (Swap.tsx)
  POST /swap/quote ──► services/swap.ts: sondea QuoterV2 (4 fee tiers) +
                       V4Quoter (4 configs hookless) en paralelo → mejor output
                       → fee policy → minimumAmountOut → persiste en D1 (TTL 60s)
  POST /swap/prepare ► re-valida la quote contra el pool; construye calldata del
                       Universal Router SERVER-SIDE (services/uniswap.ts, puro);
                       batch ERC-7821 [approve→Permit2→UR.execute] en UNA UserOp
                       patrocinada (buildSponsoredUserOp) → pending "SWAP"
  firma biométrica  ─► POST /pay/submit (flujo existente, sin cambios de cliente)
```

- **Una sola confirmación biométrica** cubre approvals + swap (batch atómico).
- El paymaster patrocina el gas (ventana `validUntil` existente).
- `/pay/submit` trata `currency: "SWAP"` como acción no-pago (no se registra
  como transferencia) y deriva el gas del `handleOps` del propio UserOp
  almacenado (los swaps usan `callGasLimit` 700k).

### 2.2 Selección de ruta

Se sondean **en paralelo y on-chain** (sin API keys):
- v3 `QuoterV2.quoteExactInputSingle` en fee tiers `100/500/3000/10000`
- v4 `V4Quoter.quoteExactInputSingle` en configs hookless
  `(100,1)/(500,10)/(3000,60)/(10000,200)`

Gana el mayor `amountOut`; en empate gana v4 (sin WRAP/UNWRAP en pares ETH,
singleton más barato). Pools inexistentes simplemente fallan su simulación y se
descartan. Single-hop por diseño (los 3 activos whitelisted tienen pools
directos en mainnet); multi-hop = TODO consciente.

### 2.3 Permit2 y smart accounts (análisis pedido)

Permit2 soporta EIP-1271, y `AccountWebAuthnV2` (ERC-7739) **podría** validar
una firma typed-data — pero producir esa firma desde WebAuthn exige el flujo de
nested typed data de ERC-7739 en el cliente, más gas de verificación P256 extra
on-chain, para ahorrar… nada: una smart account ya batchea `approve + swap`
atómicamente en una UserOp. Por eso:

- **ERC-20 de entrada:** batch `[token.approve(Permit2, monto_exacto),
  Permit2.approve(token, UniversalRouter, monto_exacto, expiración=deadline),
  UR.execute(...)]`. Allowances exactas que además expiran (uint48) — nunca
  approvals infinitos, sin residuo.
- **ETH de entrada:** solo `[UR.execute{value}]` — cero approvals.
- La firma EIP-712 de Permit2 queda como camino para **wallets externas** en el
  módulo cross-chain, donde sí ahorra una transacción.

### 2.4 Seguridad implementada

- Tokens **solo por símbolo** contra la whitelist de `shared/networks.ts` (el
  cliente jamás envía direcciones ni rutas).
- `recipient` = smart account del perfil del usuario, siempre (verificado en
  prepare contra el dueño de la quote).
- `minimumAmountOut` server-side = estimado − fee − slippage (default 0.5%,
  máx 5%); aplicado en `TAKE_ALL`/`SWEEP`/`UNWRAP` **y** gross-min en el swap.
- `deadline` obligatorio (600s) en el router; quote TTL 60s; re-cotización en
  prepare con rechazo si el precio cayó bajo el mínimo.
- Calldata construida 100% server-side desde estado persistido; chainId validado.
- Constantes de encoding verificadas contra `Commands.sol`/`Actions.sol` y
  pineadas en tests (34 tests pasan, 16 de encoders decodificando el calldata).

---

## 3. Módulo 3 — Service fees (config implementada, cobro listo para activar)

**Mecanismo elegido: comandos nativos del router** — `TAKE_PORTION` (v4) /
`PAY_PORTION` (v3) toman un % del output hacia el treasury **dentro del mismo
swap**. Sin contrato wrapper (gas extra ~0, sin superficie de auditoría nueva),
sin operación separada, visible on-chain.

**Config (env del Worker):**

| Variable | Default | Descripción |
|---|---|---|
| `PARMELIA_FEES_ENABLED` | `false` | Solo `"true"` activa fees (modo campaña = apagarlas). |
| `PARMELIA_SWAP_FEE_BPS` | `0` | Fee de swap en bps (ej. `30` = 0.30%). |
| `PARMELIA_MAX_FEE_BPS` | `100` | Techo por env; **hard cap en código: 100 bps (1%)** — el env no puede superarlo. |
| `PARMELIA_TREASURY_ADDRESS` | — | Requerida para activar fees; por red (config de wrangler por entorno). |

**Garantías:** fee mostrada en la quote antes de confirmar (`parmeliaFee`,
`parmeliaFeeBps` en la respuesta y en la UI); `minimumAmountOut` es **post-fee**
(la fee nunca rompe el mínimo del usuario); auditable: cada cobro es un
Transfer on-chain al treasury en la misma tx del swap.

**Fee cross-chain (`PARMELIA_CROSSCHAIN_FEE_BPS`)**: mismo patrón, se aplica en
el módulo 1 sobre el monto de salida cotizado. Diseñada, no implementada.

Se evaluó y descartó: integrator fee de la Trading API (dependencia de API),
wrapper propio (gas + auditoría sin necesidad), fee como UserOp separada (2
firmas o peor UX).

---

## 4. Módulo 4 — Earn con posiciones LP (diseño)

**Mecanismo:** provisión de liquidez concentrada **Uniswap v3 primero**
(PositionManager v3, tooling maduro, liquidez profunda en USDC/ETH y
USDC/WBTC). v4 para Earn cuando los corridors (módulo 5) lo justifiquen — hoy
hooks solo agregan complejidad sin edge para LP básico.

**Estrategias por riesgo** (rango alrededor del precio actual):
- Conservador: ±50% — pocas salidas de rango, menos fees.
- Moderado: ±20%.
- Agresivo: ±8% — más fees, más rebalanceo y riesgo out-of-range.

**Flujo:** elegir estrategia → depósito single-asset (Parmelia hace el **swap
parcial** con el Módulo 2 para balancear 50/50 — reuso directo) → mint de la
posición NFT **a nombre de la smart account** (no custodial) → panel con
composición, fees acumuladas, in/out of range, PnL estimado y advertencia de
pérdida impermanente → retiro (decrease + collect + swap opcional a un solo
activo).

**Copy obligatorio en UI:** "Esto no es una cuenta de ahorro" · "El rendimiento
no está garantizado" · "Estás proveyendo liquidez" · "Existe riesgo de pérdida
impermanente". Nunca un APY fijo.

**Backend nuevo:** `earn.routes.ts` (`/earn/strategies`, `/earn/quote`,
`/earn/prepare`, `/earn/positions`, `/earn/withdraw/prepare`), tabla
`earn_positions` (uid, tokenId NFT, estrategia, rango, principal, estado), cron
de monitoreo out-of-range. Todo vía el mismo pipeline UserOp+passkey.

**Performance fee:** % de las **fees cobradas** (no del principal) al hacer
collect — transfer adicional en el batch de retiro. Mismo sistema de env vars.

---

## 5. Módulo 5 — Parmelia Corridors / recorr-hook (evaluación)

**Veredicto: prometedor como diferencial, NO listo; empezar híbrido off-chain.**

El concepto (intents de DCA/swap agrupados, matching CoW interno, solo el neto
toca el AMM, dynamic fees por desbalance) es económicamente sólido para
corredores de flujo recurrente (remesas, DCA semanal). Pero:

1. **Restricción estructural:** un hook no puede añadirse a pools existentes —
   Parmelia tendría que crear **pools v4 propios** y atraer liquidez inicial
   (LP propio o incentivos). Sin volumen propio demostrado, el pool nace vacío
   y la ejecución sería peor que rutear a pools públicos. **Gate: ≥ ~$100k de
   volumen interno mensual estable antes de considerar pools propios.**
2. **PoC actual:** eliminar `tx.origin` (roto con AA: siempre es el bundler);
   diseñar roles solver/operator con allowlist; expiración + cancelación de
   intents firmados (nonce + deadline, anti-replay por chainId+contrato);
   límites duros a dynamic fees (cap en bps, rate-limit de cambio); eventos
   indexables para reconstruir el matching; suite completa (unit + fuzz de
   matching/netting + invariants: conservación de valor, ningún intent ejecuta
   peor que su límite) + fork-tests de Arbitrum.
3. **Camino recomendado (de menor a mayor riesgo):**
   - **Fase A (off-chain matching):** detectar flujos opuestos entre usuarios
     de Parmelia y ejecutarlos como transferencias internas + swap del neto vía
     Módulo 2. Sin contratos nuevos, captura ya el 80% del valor del netting.
   - **Fase B:** contrato de settlement simple (sin hook) que liquida lotes
     netos con límites firmados por usuario.
   - **Fase C:** hook v4 con dynamic fees y pools propios, solo si A/B prueban
     el volumen.

---

## 6. Variables de entorno (consolidado)

```
# Existentes
RPC_URL, PRIVATE_KEY, PAYMASTER_SIGNER_PRIVATE_KEY, FIREBASE_PROJECT_ID,
CHAIN_KEY, ALLOWED_ORIGINS

# Fees (Módulo 3)
PARMELIA_FEES_ENABLED=false
PARMELIA_SWAP_FEE_BPS=0
PARMELIA_MAX_FEE_BPS=100
PARMELIA_TREASURY_ADDRESS=

# Futuro (Módulo 1)
PARMELIA_CROSSCHAIN_FEE_BPS=
ACROSS_API_URL= / CCTP_* (al implementar)
```

## 7. Correr localmente

```bash
pnpm install
cd server && npx wrangler d1 migrations apply PARMELIA_DB --local
npx wrangler dev          # necesita .dev.vars: RPC_URL (Arbitrum Sepolia), PRIVATE_KEY, ...
pnpm --filter client dev  # VITE_CHAIN_KEY=arbitrum-sepolia
pnpm --filter server test # 34 tests (encoders, fees, validación)
cd contracts && forge test
```

## 8. TODOs reales (no implementados)

- **Deploy de contratos V2 en Arbitrum** (Sepolia/One) y rellenar
  factory/paymaster/verifier en `shared/networks.ts` — bloquea todo el flujo E2E.
- **Smoke test on-chain del swap en Arbitrum Sepolia** (los encoders están
  verificados por tests de decodificación, pero falta una ejecución real).
- Liquidez en testnet: los pools de Arbitrum Sepolia pueden no existir para
  todos los pares → la UI ya maneja "sin ruta disponible".
- Multi-hop routing (hoy single-hop; los 3 pares mainnet tienen pool directo).
- Price impact numérico en la quote (requiere spot price de referencia —
  StateView/slot0; hoy el mínimo garantizado cubre al usuario).
- Tracking post-ejecución del swap en D1 (`swap_quotes.status='executed'`) —
  hoy el cliente confirma por txHash + refresh de balances.
- Módulos 1, 4, 5 según este diseño.

## 9. Riesgos conocidos

- **Liquidez v4 variable:** mitigada por el fallback v3 cotizado en tiempo real.
- **Relayer EOA único** (ya documentado en MEJORAS_PENDIENTES #13): los swaps
  comparten el cuello de botella de pagos; migrar a bundler lo resuelve para
  ambos.
- **Quoters via eth_call:** ~8 llamadas RPC por quote; con volumen, cachear
  spot por par (TTL 5-10s) o limitar tiers sondeados.
- **WBTC custodia** (BitGo JV): riesgo aceptado por liquidez; revisar
  trimestralmente vs cbBTC; el cambio es 1 entrada de config.
- **Gas del batch swap** estimado en 700k callGasLimit (cap, no consumo); el
  consumo real esperado es ~250-400k (v4 ETH-in) a ~450k (ERC20-in + approvals).

## 10. Checklist de seguridad (verificado)

- [x] Solo tokens whitelisted (resolución por símbolo server-side)
- [x] chainId validado en quote y prepare
- [x] Sin direcciones hardcodeadas sin red (todo en `NETWORKS`, TODOs explícitos)
- [x] Approvals exactos con expiración — nunca infinitos
- [x] Slippage + deadline + minimumAmountOut obligatorios y server-side
- [x] Quotes con TTL + re-validación on-chain en prepare
- [x] Calldata nunca construida desde input del cliente
- [x] Sin private keys nuevas; sin secrets en frontend
- [x] Fees visibles pre-confirmación, hard cap 1% en código, OFF por defecto
- [x] Sin promesas de APY; copy de riesgo definido para Earn
- [x] Sin hooks en producción
- [x] Flujo de pagos/paymaster/onboarding intactos (34 tests server + build ok)
- [x] Compatible con Arbitrum Sepolia (config completa; WBTC correctamente omitido)

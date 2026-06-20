# Runbook - Poner Parmelia a funcionar en Arbitrum

> Orden exacto para activar todo lo implementado (contratos V2, ledger D1,
> indexer cron, swaps, referidos) en **Arbitrum Sepolia**. Al final, el delta
> para **Arbitrum One**.


## 1. Claves y fondos (una sola vez)

Tres roles (least-privilege; pueden ser la misma clave en testnet, pero mejor no):

| Rol | Para qué | Necesita |
|---|---|---|
| **Deployer** (tu keystore `wallet-0x75`) | Desplegar contratos + stake/deposit del paymaster | ~0.05 ETH en Arbitrum Sepolia |
| **Relayer** (`PRIVATE_KEY` del worker) | `handleOps`, crear cuentas, guardian, faucet de bienvenida | ~0.05 ETH **+ USDC de prueba** (el welcome-fund manda 5 USDC por usuario) |
| **Paymaster signer** (`PAYMASTER_SIGNER_PRIVATE_KEY`) | Firmar patrocinios de gas | Nada (solo firma) |

```bash
# Generar las claves nuevas que falten
cast wallet new   # relayer
cast wallet new   # paymaster signer
```

Fondos: ETH de Sepolia → bridge a Arbitrum Sepolia (o faucet de Arbitrum);
USDC de prueba para el **relayer** en https://faucet.circle.com (red: Arbitrum Sepolia).

## 2. Desplegar contratos (CREATE2 determinista)

```bash
cd contracts
forge script script/Deploy.s.sol:DeployV2 \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
  --account wallet-0x75 \
  --sender 0x75464f762bc50d0A0B127ab5a085504BF102Bb88 \
  --broadcast
```

**`--sender` es obligatorio** (la dirección de `wallet-0x75`). El paymaster pone
`owner = msg.sender` del script; sin `--sender`, `msg.sender` es el DefaultSender
de Foundry y el `addStake` (firmado por `wallet-0x75`) revierte con
`OwnableUnauthorizedAccount`. El script tiene una guarda que falla rápido si lo olvidas.

El summary imprime `verifier / factory / paymaster`. **Anótalos.**
(El script ya hace `addStake` 0.001 ETH y `deposit` 0.01 ETH del paymaster.)

En **testnet no necesitas** `setSponsorSigner`: el constructor ya deja al deployer
(el `--sender`) como `sponsorSigner`. Solo lo correrás si separas las claves para
mainnet (ver §11).

## 3. Verificar contratos (Sourcify - sin API key)

Opcional pero recomendado: publica el código fuente para inspeccionar e
interactuar con los contratos desde el explorador. `forge verify-contract` usa
**Sourcify por defecto** (no requiere API key) y `--watch` espera hasta confirmar
`Status: exact_match`.

Usa las direcciones del summary del paso 2 y verifica **en este orden** (el
verifier y la implementación no llevan constructor-args; factory y paymaster sí):

```bash
cd contracts

# 1. Verifier WebAuthn (sin constructor-args)
forge verify-contract <VERIFIER> src/ERC7913WebAuthnVerifier.sol:ERC7913WebAuthnVerifier \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch

# 2. Implementación de la smart account (sin constructor-args)
forge verify-contract <ACCOUNT_IMPL> src/AccountWebAuthnV2.sol:AccountWebAuthnV2 \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch

# 3. Factory - constructor: la dirección de la implementación
forge verify-contract <FACTORY> src/AccountFactoryV2.sol:AccountFactoryV2 \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch \
  --constructor-args $(cast abi-encode "constructor(address)" <ACCOUNT_IMPL>)

# 4. Paymaster - constructor: EntryPoint + owner (= el --sender del deploy)
forge verify-contract <PAYMASTER> src/ParmeliaPaymaster.sol:ParmeliaPaymaster \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch \
  --constructor-args $(cast abi-encode "constructor(address,address)" \
    0x433709009B8330FDa32311DF1C2AFA402eD8D009 <DEPLOYER>)
```

Notas:
- Los `--constructor-args` deben coincidir **exacto** con los del deploy. En el
  paymaster, el 2º arg es el owner = tu `--sender` (`wallet-0x75`); si pones otra
  dirección la verificación falla (`bytecode mismatch`).
- `$(cast abi-encode ...)` es sintaxis de bash (Git Bash); funciona tal cual.
- Verificar es idempotente: re-correrlo sobre un contrato ya verificado responde
  "already verified".
- ¿Prefieres **Arbiscan** en vez de Sourcify? Añade
  `--verifier etherscan --etherscan-api-key <API_KEY>` (requiere cuenta Arbiscan).
  Sourcify basta para leer/interactuar y no pide key.

## 4. Rellenar direcciones en `shared/networks.ts`

En `NETWORKS["arbitrum-sepolia"].contracts` reemplaza los `TODO_DEPLOY`:
`factory`, `paymaster`, `verifier` (los del paso 2). EntryPoint y USDC ya están.

> **Desplegado y verificado en Arbitrum Sepolia (jun 2026):**
> | Contrato | Dirección |
> |---|---|
> | verifier  | `0xb7fA10dEe75042D6973676A7d7882e4621B806d6` |
> | impl      | `0xa450bc49a0dA738FA348445980b542d78A22527e` |
> | factory   | `0x75c7761dcED5F8eCc708E750bDe5CA7d4557EDEB` |
> | paymaster | `0x31f357a64cF5899da21337f0D9e28ef8D6385753` |
>
> La `impl` no va en `networks.ts` (la factory ya la referencia); solo se usó para
> verificar. Si re-despliegas con distinto bytecode (cambio de `foundry.toml` o de
> contratos), estas direcciones cambian.

## 5. Base de datos remota (esquema v2, una sola migración)

```bash
cd server
npx wrangler d1 migrations apply PARMELIA_DB --remote
```

Aplica `0001_schema.sql` (esquema consolidado con prólogo DROP: resetea la DB
vieja de testnet a v2 - ledger, referidos, swap_quotes, contactos, y token FCM).
Decisión ya tomada: los datos eran desechables.

## 6. Secrets del worker

```bash
cd server
npx wrangler secret put RPC_URL
#   admite VARIAS urls separadas por coma (failover), p. ej.:
#   https://sepolia-rollup.arbitrum.io/rpc,https://arbitrum-sepolia.publicnode.com
npx wrangler secret put PRIVATE_KEY                    # relayer
npx wrangler secret put PAYMASTER_SIGNER_PRIVATE_KEY   # paymaster signer
# Opcionales (feature-flag: sin definir, la app funciona igual):
npx wrangler secret put TURNSTILE_SECRET_KEY           # anti-abuso en crear cuenta + faucet
Get-Content -Raw ..\<service-account>.json | npx wrangler secret put FCM_SERVICE_ACCOUNT  # push
```

Ya configurado en `wrangler.jsonc` (no requiere acción): `CHAIN_KEY=arbitrum-sepolia`,
`ALLOWED_ORIGINS`, cron del indexer cada 2 min. Fees: apagadas por defecto
(`PARMELIA_FEES_ENABLED` etc. cuando decidas cobrar).

### RPC: público vs dedicado (Alchemy/Infura/dRPC)

`RPC_URL` admite **varias URLs separadas por coma**; el worker arma un `fallback()`
con ellas (`server/src/services/clients.ts`), así que si la primera falla pasa a la
siguiente. No se usa ninguna API propietaria del proveedor; cualquier RPC compatible
sirve.

- **Testnet / demo:** el endpoint público de Arbitrum es suficiente.
- **Mainnet / producción:** usar un RPC **dedicado como primario** y el público como
  **fallback**. El cuello de botella es el indexer: hace `eth_getLogs` por bloques en
  cada cron (cada 2 min); los endpoints públicos throttlean (429) y se pueden **perder
  depósitos/pagos**, además de no tener SLA. Un dedicado da cuota alta, rangos de
  `getLogs` mayores, uptime y un dashboard para depurar. Alchemy, Infura, dRPC y
  QuickNode son equivalentes para este uso.

```bash
# Ejemplo mainnet: dedicado primero, público de respaldo
npx wrangler secret put RPC_URL
#   https://arb-mainnet.g.alchemy.com/v2/<API_KEY>,https://arb1.arbitrum.io/rpc
```

La clave del proveedor va **dentro de la URL** y por eso es un secret (`wrangler
secret put`), no una var en `wrangler.jsonc`.

Consola Firebase (para login por correo/Apple, push y analytics): habilitar
Email link (y Apple si aplica), activar account-linking "same email", generar la
VAPID y el service account, y habilitar GA4. Detalle paso a paso en `INTEGRACIONES.md`.

## 7. Desplegar el worker (registra también el cron)

```bash
cd server
npx wrangler deploy
```

## 8. Cliente

**Local** - `client/.env` (ya con `VITE_CHAIN_KEY=arbitrum-sepolia`). Añade las
de integraciones cuando las tengas:
```
VITE_SERVER_URL=https://server.parmelia.workers.dev
VITE_TURNSTILE_SITE_KEY=...        # site key de Turnstile (pública)
VITE_FIREBASE_VAPID_KEY=...        # VAPID pública (web push)
VITE_FIREBASE_MEASUREMENT_ID=...   # G-XXXX cuando habilites GA4
```
```bash
pnpm --filter client dev
```

**Producción (Vercel)** - mismas env vars en el dashboard (las `VITE_FIREBASE_*` ya existen) y redeploy.

## 9. Smoke test (en orden)

```bash
pnpm --filter server test        # 34 tests
cd contracts && forge test       # 32 tests
cd server && npx wrangler tail   # dejar abierto para ver logs
```

En la app:
1. Login → Onboarding → crear cuenta (passkey). ✓ wallet creada + **5 USDC de bienvenida** (si falla, al relayer le falta USDC/ETH).
2. Crear link de cobro → pagarlo desde una segunda cuenta. ✓ ambos lados aparecen en Actividad/Extractos (ledger).
3. `/swap`: cotizar USDC/ETH. Nota: en Sepolia puede no haber liquidez v3/v4 ("sin ruta disponible" es esperado); el flujo completo se valida en One.
4. En `wrangler tail`, esperar un log `indexer_run` (cron cada 2 min).
5. Enviar USDC a la wallet desde una EOA externa → en ≤2 min aparece "Depósito recibido".
6. Contactos: copiar tu código, abrir `localhost:5173/?ref=CODIGO` en incógnito, crear cuenta → el contador sube.

## 10. Delta para Arbitrum One (cuando toque)

1. Mismo `forge script` con `--rpc-url https://arb1.arbitrum.io/rpc` y `--sender <DIRECCION_DE_TU_EOA>` (el parámetro `--sender` sigue siendo obligatorio para evitar la guarda del DefaultSender de Foundry) - CREATE2 da
   **las mismas direcciones** si el bytecode no cambió → rellenar `arbitrum-one.contracts`.
2. `CHAIN_KEY=arbitrum-one` en `wrangler.jsonc` + secrets de mainnet (RPC, claves fondeadas con ETH real).
3. Quitar/ajustar el faucet de bienvenida (5 USDC reales por usuario = decisión de negocio).
4. Activar fees si quieres: `PARMELIA_FEES_ENABLED=true`, `PARMELIA_SWAP_FEE_BPS`, `PARMELIA_TREASURY_ADDRESS`.
5. El bridge (`/depositar`) se activa solo en One; re-verificar las USDC externas contra Circle docs.
6. **Separar las claves de infra** - ver sección 11. Es el cambio más importante para mainnet.
7. Otros pendientes P1 antes de público real: rate limiting de zona, bundler gestionado (#13).

## 11. Consideraciones de seguridad para mainnet (separación de claves)

> **En testnet (Arbitrum Sepolia) está bien usar UNA sola EOA para todo**
> (deployer = relayer = paymaster signer = guardian, misma `PRIVATE_KEY`).
> Son fondos de prueba: el riesgo es cero y simplifica el setup. Lo de abajo
> **NO aplica al deploy de testnet** - es la lista para endurecer antes de mainnet.

### Por qué importa en mainnet

El `forge script` deja a la EOA que despliega (`wallet-0x75`) como **owner del
Paymaster** (`Ownable2Step`) y como **`sponsorSigner` inicial**. El owner puede
`withdrawTo` (retirar el depósito de gas), `setSponsorSigner` y `addStake`: es la
clave más poderosa de la infra. Si además esa misma clave se usa como
`PRIVATE_KEY` (relayer) y `PAYMASTER_SIGNER_PRIVATE_KEY` en el worker, **una sola
filtración compromete toda la infra**.

Importante: **los fondos de los usuarios siguen a salvo** pase lo que pase -
moverlos exige su passkey. El daño máximo de una clave de infra comprometida es
gastar el gas/faucet, spamear, o *proponer* un recovery (mitigado por timelock de
48h + cancelación del usuario). Lo que protegemos aquí es el dinero del gas y la
disponibilidad del servicio, no la custodia.

### Setup recomendado: 3 claves separadas

| Clave | Rol | Dónde vive | Poder |
|---|---|---|---|
| **Deployer** (`wallet-0x75`) | Desplegar + **owner del Paymaster** | **FRÍA, fuera del worker** (hardware wallet ideal) | Retira el depósito de gas, rota el signer, stake |
| **Relayer** (nueva) | `PRIVATE_KEY` del worker: `handleOps`, crear cuentas, guardian, faucet | Caliente, en el worker | Gasta su ETH/USDC; propone recovery (timelock) |
| **Paymaster signer** (nueva) | `PAYMASTER_SIGNER_PRIVATE_KEY`: firma patrocinios | Caliente, en el worker | Solo firma (sin fondos) |

Pasos:
1. Despliega con `wallet-0x75` (sección 2) y **mantenla fría** - nunca la pongas en los secrets del worker.
2. Genera dos claves nuevas (`cast wallet new` x2): relayer y paymaster signer.
3. **Obligatorio:** `cast send <PAYMASTER> "setSponsorSigner(address)" <ADDR_PAYMASTER_SIGNER> --account wallet-0x75`.
   Si separas el signer pero **omites este paso, todo UserOp revierte** con `InvalidPaymasterSignature` (el paymaster solo acepta firmas de su `sponsorSigner`).
4. Pon relayer y paymaster signer en los secrets del worker. La clave-admin nunca se expone: si el worker se compromete, `wallet-0x75` rota el signer y retira el depósito.

### Pendientes de hardening (código)

- **Guardian dedicado (#8):** hoy el guardian de cada cuenta = el relayer (`account.routes.ts`, `guardianAddress = serverAccount.address`). Para mainnet conviene una clave/contrato de guardian separado de la clave caliente del relayer. Es un cambio de código pequeño (un `GUARDIAN_*` propio en `buildInitCallData`); pídelo cuando se vaya a mainnet.
- **Least-privilege (#7):** idealmente deployer / faucet / guardian / relayer en EOAs distintas.
- **Depósito del paymaster:** el script deja 0.01 ETH; recargar según volumen real.
- **Mismo `foundry.toml`** (solc + optimizer) entre testnet y mainnet para que CREATE2 dé las mismas direcciones.

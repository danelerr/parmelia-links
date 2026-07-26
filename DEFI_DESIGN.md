# Parmelia DeFi — Diseño definitivo (v2.0)

> Arquitectura DeFi de Parmelia sobre Arbitrum. **Swaps (§5) y fees de swap (§6)
> están implementados**; este documento CIERRA el debate del módulo Earn (§0-§4,
> §7-§13) y mantiene el veredicto por fases de Corridors (§14). Cross-chain vive
> en `CROSSCHAIN_DESIGN.md`. Fecha: julio 2026. Changelog en §16.
>
> Las decisiones de §2, §3 y §13 no se re-litigan salvo que cambie un hecho
> externo (Aave sale de Arbitrum, cambia el pricing, cambia el alcance de
> producto). Si una conversación futura vuelve a abrir "¿y si LP / y si
> agregadores / y si niveles de riesgo?", la respuesta está en §13.

---

## 0. Veredicto

El debate de Earn nunca convergió porque el diseño anterior mezclaba **dos
productos distintos bajo un solo nombre**, y la contradicción estaba escrita en
el propio documento: el backlog pide un **"Modo Ahorro"** (MEJORAS #37), pero el
§4 anterior diseñaba **posiciones LP de Uniswap v3 con tres niveles de riesgo**
— un producto cuyo copy obligatorio decía, literalmente, *"Esto no es una cuenta
de ahorro"*. No había forma de ponerse de acuerdo porque se discutían dos cosas
a la vez.

La resolución fría:

> **Earn v1 = suministro de USDC en Aave v3, directo desde la smart account del
> usuario. Un solo producto ("Ahorro"), un solo activo (USDC), un solo protocolo
> (Aave v3), cero contratos nuevos, cero custodia, cero exposición a precio.**
> Las posiciones LP no son ahorro: quedan como un producto SEPARADO y futuro
> ("Inversión"), detrás de gates explícitos (§12), posiblemente para siempre.

Por qué esto cierra el debate:

1. **La promesa del producto define el instrumento, no al revés.** El usuario de
   Parmelia (LatAm, ahorra en dólares digitales, cero cultura DeFi) espera de un
   "Modo Ahorro" exactamente tres cosas: el principal se mantiene en USDC, se
   puede retirar cuando quiera, y crece. Aave v3 supply cumple las tres. Una LP
   USDC/WETH viola la primera (el "ahorro" queda expuesto a ETH y puede BAJAR en
   términos de USDC) — no es una opción conservadora de lo mismo, es otro
   producto.
2. **Los datos empíricos condenan la LP pasiva como vehículo de ahorro.** El
   estudio TopazeBlue/Bancor sobre Uniswap v3 (17.000 wallets, 17 pools, 43% del
   TVL analizado): los pools generaron $199M en fees pero incurrieron $260M en
   pérdida impermanente; **el 49.5% de los LPs terminó peor que si no hubiera
   hecho nada** (caveat honesto: estudio comisionado por Bancor, que vende la
   alternativa; el análisis académico posterior — arXiv 2111.09192, SIAM 2024 —
   confirma la magnitud del IL en v3). Ofrecerle eso a un ahorrista sin
   sofisticación, bajo la palabra "ahorro", es indefendible.
3. **La integración es trivial y no agrega superficie.** Supply/withdraw de Aave
   son dos llamadas; el aToken vive en la smart account del usuario (no
   custodial); no hay contratos nuevos que auditar, no hay rebalanceos, no hay
   cron nuevo, no hay dependencia del bundler (#13). Reusa entero el pipeline
   UserOp + passkey + paymaster + ciclo de vida de pagos ya endurecido.
4. **El fee no es una decisión de v1** — la matemática lo demuestra (§8.2). Earn
   v1 es retención, no ingreso; discutir el performance fee ahora era otra
   fuente de debate sin consecuencia.

---

## 1. Alcance y no-objetivos

**Objetivo de Earn v1:** que un usuario mueva USDC entre su "saldo disponible" y
su "ahorro" (Aave v3) con una confirmación biométrica, viendo una tasa variable
honesta, y pueda salir cuando quiera — incluso si Parmelia desaparece (§4, E2).

**No-objetivos permanentes de esta versión** (cambiarlos exige nuevo diseño):
niveles de riesgo; LP como "ahorro"; multi-protocolo dinámico (routing de yield);
agregadores/vaults de terceros (Yearn/Beefy) como default; RWA/T-bills
tokenizados (KYC/permisos); auto-enrolar el saldo de pagos en yield; prometer o
fijar APY; apalancamiento; activos distintos de USDC en v1 (la ruta para
ETH/WBTC es swap interno → USDC → Ahorro, no mercados nuevos).

---

## 2. La decisión: Aave v3 supply, y el procedimiento para el futuro

**Por qué Aave v3 y no otro protocolo de lending:** es el mercado de dinero más
grande y más batalla-probado de Arbitrum (USDC nativo: ~$168M suministrados,
utilización sana, años en producción multi-chain, programa de auditorías y bug
bounty permanentes), el aToken (`aArbUSDCn`) es un rebasing 1:1 que hace el
"saldo ahorrado" trivial de mostrar, el retiro es inmediato salvo utilización
extrema, y — verificado — **tiene mercado de testnet en Arbitrum Sepolia**
(`proto_arbitrum_sepolia_v3`, con faucet y el Pool en la MISMA dirección
determinista), así que el módulo se construye y se prueba e2e en la red actual
sin esperar mainnet.

| Parámetro | Valor (verificado contra el aave-address-book 2026-07-03; en `shared/networks.ts`) |
|---|---|
| Pool v3 Arbitrum One | `0x794a61358D6845594F94dc1DB02A252b5b4814aD` · aToken USDCn `0x724d…C637` |
| Pool v3 Arbitrum Sepolia | `0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff` · aToken `0x460b…1216` — OJO: las direcciones de Aave NO son deterministas entre redes (a diferencia de los contratos propios); siempre tomarlas del address book |
| Activo | USDC nativo (`0xaf88…5831` en One; en Sepolia el reserve usa **el mismo Circle USDC** `0x75fa…AA4d` de Parmelia — Earn es 100% probable en testnet) |
| Recibo | aToken rebasing (1:1); `balanceOf` crece solo — es el saldo ahorrado |
| Tasa | `getReserveData(usdc).currentLiquidityRate` (RAY, APR anualizado) → APY on-chain, sin APIs |
| APY observado | ~2.5% hoy; rango típico 2026: 3-7% según red/demanda. **Variable, jamás prometida** |

### 2.1 Procedimiento de decisión para casos futuros

| Pregunta | Regla |
|---|---|
| ¿El APY de Aave cae a ~0 sostenido? | No rotar automáticamente. Evaluar UN protocolo alternativo pre-aprobado (§3, Compound v3) como cambio de versión deliberado, comunicado, con su propia revisión. |
| ¿Agregar otro activo al Ahorro? | No. USDC es el producto. ETH/WBTC → swap interno primero. |
| ¿Otro protocolo "paga más"? | Solo se evalúa si supera a Aave en LAS TRES: madurez/track-record, liquidez del mercado USDC en Arbitrum, y simplicidad de integración sin contratos propios. El yield marginal NO es criterio suficiente. |
| ¿Fee de Parmelia? | Cerrado para v1 (= 0). Se reabre únicamente cuando el gate de §8.2 se cumpla. |

---

## 3. Por qué NO las alternativas

| Opción | Problema decisivo |
|---|---|
| **LP Uniswap v3 (USDC/WETH), "3 niveles de riesgo"** | No es ahorro: expone el principal a ETH (IL); ~50% de LPs pasivos pierden vs HODL (§0.2); exige rebalanceo activo (gas + swaps + IL realizado) y un cron de monitoreo; multiplica operaciones → dependía del bundler #13. Queda como producto "Inversión" separado, Fase 3, quizá nunca (§12). |
| **LP estable (USDC/USDT 0.01%)** | IL casi nulo pero yield fino (<1-2%), gestión de rango igual, y agrega exposición USDT/depeg. Más piezas que Aave para peor resultado neto. |
| **Compound v3 (Comet, USDC nativo en Arbitrum)** | Alternativa legítima y verificada (mercado nativo vivo desde la proposal 178; cUSDCv3 también rebasing). Pierde con Aave solo por profundidad/track-record en Arbitrum. **Queda como runner-up pre-aprobado** si Aave falla el procedimiento §2.1. |
| **Agregadores / vaults ERC-4626 de terceros (Yearn, Beefy)** | Capa extra de contrato + fee apilada + estrategias que rotan (inexplicables al usuario). Nada que Parmelia necesite para "USDC gana interés". |
| **RWA / T-bills tokenizados (USDY, etc.)** | KYC, listas de permitidos, restricciones de transferencia — incompatible con una smart account permissionless y con el público objetivo. |
| **CeFi / custodial yield** | Viola la tesis entera del producto (no custodial). Nunca. |
| **Auto-enrolar el saldo de pagos** | El saldo de pagos necesita liquidez instantánea garantizada y cero sorpresas; el ahorro es opt-in con "bolsillo" separado. Mezclar ambos añade riesgo al core por conveniencia marginal. |

---

## 4. Invariantes del sistema (Earn)

| # | Invariante | Dónde se garantiza |
|---|---|---|
| E1 | **Cero custodia.** El USDC va smart account ↔ Pool de Aave directo; el aToken vive en la cuenta del usuario. Parmelia nunca toca los fondos. | UserOp batch `[approve(Pool), supply(onBehalfOf=cuenta)]` / `[withdraw(to=cuenta)]`. |
| E2 | **Salida sin Parmelia.** Si Parmelia desaparece, el usuario sigue siendo dueño del aToken y puede retirar interactuando con Aave por cualquier medio. | Consecuencia de E1; documentarlo en el copy de la UI. |
| E3 | **La tasa jamás se promete.** Se muestra la tasa viva on-chain con la palabra "variable"; sin proyecciones, sin "hasta X%". | `/earn/config` lee `currentLiquidityRate` on-chain; copy fijo. |
| E4 | **El principal no se expone a precio en v1.** USDC entra, USDC sale. Sin IL, sin pares, sin apalancamiento. | Alcance §1; whitelist de un solo mercado. |
| E5 | **Un protocolo por producto, fijado en config.** Sin routing dinámico de yield. | `shared/networks.ts` → `aave: { pool, aUsdc } | null` (null = Earn apagado en esa red). |
| E6 | **Toda operación pasa por el ciclo de vida endurecido de pagos.** Claim atómico, verdad por `UserOperationEvent`, liquidación idempotente, reconciliador. | Currencies `EARN_DEPOSIT`/`EARN_WITHDRAW` en el pipeline `/pay/submit` existente. |
| E7 | **Fee solo sobre el yield, nunca sobre el principal, y solo vía wrapper auditado.** En v1: fee = 0. | Gate de §8.2; no existe mecanismo de fee en v1 a propósito. |
| E8 | **Direcciones pineadas y verificadas** contra la documentación oficial de Aave con fecha registrada. | `shared/networks.ts` + §15. |

---

## 5. Módulo swaps (IMPLEMENTADO — referencia)

Sin cambios de diseño. Universal Router (v4-compatible) como única superficie;
v4-first con fallback v3 decidido por cotización real on-chain (QuoterV2 +
V4Quoter, sin API keys); approvals exactos batcheados con expiración (nunca
infinitos — con smart accounts el batch ERC-7821 hace innecesaria la firma
EIP-712 de Permit2); `minimumAmountOut`/deadline/slippage server-side; calldata
100% server-side; tokens solo por símbolo contra whitelist; WBTC como wrapper
BTC (config-driven, revisar vs cbBTC trimestralmente). Pipeline: quote (TTL 60s)
→ prepare (re-valida y construye el batch) → firma passkey → `/pay/submit`.

Notas operativas vigentes: cada quote son ~8 `eth_call` (con volumen, cachear
spot por par TTL 5-10s o limitar tiers); multi-hop sigue siendo TODO consciente
(los pares whitelisted tienen pool directo en mainnet); smoke on-chain del swap
pendiente tras el deploy (los encoders están verificados por tests de
decodificación).

## 6. Módulo fees de swap (IMPLEMENTADO — referencia)

`TAKE_PORTION`/`PAY_PORTION` nativos del router (sin contrato wrapper), fee
visible pre-confirmación, `minimumAmountOut` post-fee, hard cap 1% en código,
OFF por defecto (`PARMELIA_FEES_ENABLED`). Cada cobro es un Transfer on-chain al
treasury en la misma tx.

---

## 7. Arquitectura de Earn v1 (cinco capas)

### 7.1 Contratos
**Ninguno nuevo.** Se interactúa con el Pool de Aave v3 ya desplegado y
auditado. Interfaz usada: `supply(asset, amount, onBehalfOf, referralCode=0)`,
`withdraw(asset, amount | type(uint256).max, to)`, `getReserveData(asset)`
(tasa + estado del reserve), `aToken.balanceOf(cuenta)`.

### 7.2 Server
- `GET /earn/config` — habilitado (config presente + `EARN_PAUSED != "true"` +
  reserve activo/no pausado on-chain), APY vivo (de `currentLiquidityRate`,
  cache ~60s), mínimo de depósito.
- `POST /earn/prepare` — `{ action: "deposit" | "withdraw", amount | "max" }`.
  Valida saldo (USDC disponible para deposit; aToken para withdraw), construye
  el batch ERC-7821 (`[approve exacto, supply]` o `[withdraw]`) con
  `buildSponsoredUserOp`, persiste el pending con currency
  `EARN_DEPOSIT`/`EARN_WITHDRAW` → el cliente firma y envía por `/pay/submit`
  (sin cambios en ese pipeline más que la rama de liquidación).
- Liquidación (`services/settlement.ts`): rama nueva que escribe el ledger —
  deposit = `out` (sale del disponible), withdraw = `in`; `kind: "earn"`.
- Saldo: `/user/balance` suma `savings` (balance del aToken) como bolsillo
  separado del disponible.

### 7.3 Datos
Sin tabla nueva. Migración `0008`: extender el CHECK de `ledger.kind` para
incluir `'earn'` (rebuild copy-swap del ledger, mismo patrón que 0006). El
estado del ahorro NO se replica en D1: la fuente de verdad es el aToken
on-chain (evita toda reconciliación de intereses).

### 7.4 Cliente
`Earn.tsx` pasa de pantalla informativa a producto: saldo ahorrado (aToken,
crece solo), tasa viva con "variable", Depositar / Retirar (AmountInput +
hoja de confirmación), movimientos en el extracto, y el copy honesto fijo:
"Tasa variable, no garantizada" · "Fondos prestados a través de Aave, un
protocolo público; existe riesgo de contrato inteligente" · "Retiras cuando
quieras (sujeto a liquidez del protocolo, históricamente inmediata)" ·
"Tus fondos siguen siendo tuyos: Parmelia nunca los custodia".

### 7.5 Operación
Mínima por diseño: sin cron nuevo, sin claves nuevas, sin gas nuevo (el
paymaster patrocina igual que un pago). Monitoreo: (a) flag on-chain del
reserve (activo/pausado/congelado) leído en `/earn/config` — si Aave pausa,
Earn se muestra "retiros solo" o "no disponible" con honestidad; (b) alerta si
el APY cae bajo un umbral (informativa, §2.1); (c) `EARN_PAUSED` como kill
switch de producto.

---

## 8. Números

### 8.1 Rendimiento (verificado jul-2026; mostrar siempre en vivo)
USDC en Aave v3 Arbitrum: ~2.5% APY hoy; el rango típico 2026 entre
deployments v3 es 3-7% según demanda de préstamo. Comparación que justifica el
producto: la alternativa del usuario objetivo es 0% (USDC quieto) o rieles
CeFi/custodiales. No competimos con degen yield; competimos con cero.

### 8.2 Por qué fee = 0 en v1 (el gate que cierra el debate del fee)
Un performance fee no custodial exige un vault wrapper propio (ERC-4626 sobre
aUSDC) — contrato nuevo + auditoría externa (~$30-80k) + operación. La
matemática: 10% de fee sobre un yield del 3% = 30 bps del TVL al año. Para que
el fee PAGUE solo la auditoría se necesitan **$10-25M de TVL sostenido**. A la
escala actual y previsible, Earn es **retención** (razón para dejar los dólares
en Parmelia), no ingreso. El wrapper con fee (Fase 2) se reabre solo cuando
TVL × yield × fee > costo de auditoría + operación, con margen.

---

## 9. Seguridad

- Riesgo principal: **contrato/protocolo Aave** — mitigado por elección (el
  lending market más auditado y con más TVL histórico de la categoría), no
  eliminado. El copy lo declara (E3/§7.4); no se maquilla.
- Riesgo de mercado del RESERVE: utilización 100% → retiro temporalmente no
  ejecutable (§10). Riesgo de governance de Aave (cambios de parámetros):
  aceptado, mismo perfil que cualquier integración DeFi seria.
- Depeg de USDC: fuera del alcance de Earn — es idéntico a tener USDC en la
  wallet (riesgo base de todo el producto Parmelia).
- Server-side siempre: montos validados/recomputados, mercado fijado por config
  (el cliente jamás envía direcciones), calldata construida en el server, y el
  pipeline de submit endurecido (E6) da claim atómico + verdad por evento +
  reconciliación ante muerte del Worker.
- Sin claves nuevas, sin custodia, sin approvals infinitos (approve exacto por
  depósito).

---

## 10. Modos de fallo y recuperación

| Modo de fallo | Detección | Manejo |
|---|---|---|
| Reserve pausado/congelado por Aave | Flag on-chain en `/earn/config` | UI honesta: "retiros solo" (frozen permite withdraw) o "no disponible" (paused). Sin acción de fondos. |
| Utilización 100% al retirar | `withdraw` revierte → `UserOperationEvent(success=false)` → op `failed`, nada se movió | UI: "liquidez del protocolo agotada momentáneamente, intenta más tarde". Históricamente raro y breve (la tasa sube y atrae repagos). |
| APY → ~0 sostenido | Alerta informativa | Procedimiento §2.1 (evaluación deliberada, no rotación automática). |
| Worker muere durante deposit/withdraw | Ciclo de vida de pagos (E6) | Reconciliador liquida o marca `failed` desde la verdad on-chain. |
| Supply cap del reserve alcanzado | `supply` revierte → `failed` | UI: "límite del mercado alcanzado"; raro en USDC Arbitrum. |
| Incidente de seguridad en Aave | Kill switch `EARN_PAUSED` + comunicación | Los aTokens son del usuario; las opciones son las mismas que las de todo Aave. Ese es el riesgo declarado del producto. |

---

## 11. Checklist de activación

**Construcción — COMPLETADA (2026-07-03):**
1. ✅ Config `aave` por red en `shared/networks.ts` (Sepolia + One), direcciones
   verificadas contra el aave-address-book de BGD con fecha.
2. ✅ Migración `0008_earn.sql` (ledger kind `'earn'`, rebuild copy-swap).
3. ✅ `services/earn.ts` (ABI, APY de ray, flags del reserve, builders de batch)
   + `earn.routes.ts` (`GET /earn/config`, `POST /earn/prepare`) + rama de
   settlement (`EARN_DEPOSIT`/`EARN_WITHDRAW` → ledger `earn`) + 8 tests
   (matemática de tasa, bits del reserve, encoding pineado por decodificación).
4. ✅ `Earn.tsx` producto (saldo vivo, APY variable, depositar/retirar con
   confirmación, retiro total vía sentinel uint256.max, copy de riesgo
   obligatorio) + i18n ES/EN + `savings` en `/user/balance` y en `/earn/config`.
5. ⬜ Smoke e2e en Arbitrum Sepolia con el faucet de Aave
   (`proto_arbitrum_sepolia_v3`) — requiere entorno desplegado (operador):
   aplicar migraciones 0006-0008, `wrangler deploy`, redeploy del cliente.

**Mainnet (además de los gates generales del proyecto):**
1. Verificar Pool/aToken/estado del mercado USDC nativo en One (no USDC.e).
2. Depósito propio de prueba (montos reales pequeños) antes de exponer la UI.
3. Alertas de §7.5 conectadas. `EARN_PAUSED` probado.

---

## 12. Roadmap

- **Fase 0 — Earn v1 (Aave supply):** lo de §11. Sin dependencia del bundler ni
  de nada externo al deploy normal.
- **Fase 1 — Calidad:** gráfico simple de crecimiento (snapshots de APY vía un
  cron ligero), "ahorro automático" opcional (sugerir mover excedente del
  disponible — siempre con confirmación explícita, nunca auto-enroll).
- **Fase 2 — Vault con performance fee (ERC-4626 sobre aUSDC):** SOLO si se
  cumple el gate de §8.2. Contrato inmutable (no UUPS para vaults), revisión
  externa previa obligatoria, fee solo sobre yield (E7). Nota sobre la
  "obligación": nadie externo la impone — es el seguro autoimpuesto del único
  contrato del diseño que concentraría fondos ajenos bajo código propio, y el
  gate de §8.2 significa que solo se paga cuando el negocio la cubre. El menú
  de revisión, de menor a mayor costo: base de código ya auditado con
  modificación mínima (código modificado NO hereda auditorías), concursos
  competitivos (Code4rena/Sherlock/Cantina), bug bounty (Immunefi), firma
  boutique; y en cualquier caso, lanzamiento con **caps duros de depósito**
  escalados con el tiempo en producción (el patrón del propio Aave v4).
  **Blueprint candidato:
  las Yield Donating Strategies de Octant v2** (golemfoundation/octant-v2-core,
  ERC-4626, open source): implementan exactamente "principal intacto, yield
  redirigido a una dirección configurada" — con la dirección apuntando al
  treasury (o un split usuario/treasury) es el performance fee no custodial; y
  su mecánica de pérdidas (las shares del yield-receptor se queman PRIMERO como
  buffer antes de socializar) protege el price-per-share del ahorrista.
  Verificado (jul-2026): su catálogo YA incluye una **estrategia YDS sobre Aave
  v3** y **payment splitters** de fábrica (split usuario/treasury listo), y la
  infraestructura NO cobra fee a integradores — el 70/25/5 de sus docs es el
  reparto del staking propio de Golem Foundation, no un peaje. Evaluar
  fork/deploy de ese código contra escribirlo de cero cuando el gate se cumpla
  (revisar licencia y estado de auditoría del repo); la revisión propia sigue
  siendo obligatoria (código ajeno modificado ≠ auditado).
- **Fase 3 — "Inversión" (LP), separado y quizá nunca:** producto aparte con
  nombre aparte, framing de riesgo aparte, y el copy del diseño anterior
  ("no es una cuenta de ahorro", IL explicada). Gates: bundler #13 operativo
  (rebalanceos), demanda demostrada, y que Ahorro v1 lleve ≥ un trimestre
  estable. La mecánica LP diseñada en la versión anterior de este doc queda
  archivada en git como referencia.

## 13. Preguntas cerradas (no re-litigar)

| Pregunta recurrente | Respuesta cerrada | Razón corta |
|---|---|---|
| ¿LP v3 como Earn? | No. Nunca como "Ahorro". | IL + exposición a ETH viola la promesa; 49.5% de LPs pierden vs HODL (§0.2). |
| ¿Tres niveles de riesgo? | No en Ahorro. | Un ahorrista no elige "riesgo de su caja de ahorro"; los niveles eran el producto LP disfrazado. |
| ¿Yearn/Beefy/agregadores? | No. | Capa de contrato + fee apilada sin necesidad. |
| ¿Compound en vez de Aave? | Runner-up pre-aprobado, no default. | Aave gana en profundidad/track-record en Arbitrum; Comet queda como plan B (§2.1). |
| ¿RWA/T-bills? | No. | KYC/permisos incompatibles con el producto. |
| ¿Prometer APY? | Jamás. | E3. Tasa viva + "variable". |
| ¿Auto-enrolar el saldo? | No. Opt-in con bolsillo separado. | El saldo de pagos exige liquidez instantánea y cero sorpresas. |
| ¿Performance fee en v1? | 0. | Matemática de §8.2: no paga ni la auditoría del wrapper que lo haría posible. |
| ¿Esperar al bundler #13? | No hace falta para Aave. | Supply/withdraw son operaciones únicas, sin rebalanceo. |
| ¿Multi-protocolo / yield routing? | No. | Un protocolo explicable > 50 bps extra inexplicables. |
| ¿Aave v4 en vez de v3? | No por ahora. | v4 salió el 30-mar-2026 SOLO en Ethereum mainnet (hub-and-spoke, caps conservadores, foco fixed-rate/RWA); no existe en Arbitrum y el gas de mainnet mata al ahorrista chico. Cuando llegue a Arbitrum Y tenga track record, se evalúa por el procedimiento §2.1 como cambio de versión deliberado. v3 sigue siendo el deployment activo y probado de Arbitrum. |
| ¿Octant v2 en Earn? | No en v1; sí como blueprint de Fase 2. | Es infraestructura de "yield redirigido" (ERC-4626), no una fuente de yield: agregarlo en v1 sería la capa de vault de terceros que E5/§3 excluye. Su código abierto es el mejor candidato para el vault con performance fee de Fase 2, y "donar tu rendimiento" queda como feature opcional futura. |
| ¿Se usa ERC-4626 en v1? | No. El aToken es un ERC-20 rebasing, no un vault 4626; la integración llama al Pool directo sin contratos intermedios (E1/E2). | ERC-4626 entra recién en Fase 2, donde el performance fee EXIGE contabilidad shares-vs-assets — que es lo que ese estándar resuelve. Candidatos base: YDS de Octant v2 (4626) y el stataToken oficial de Aave (wrapper 4626 no-rebasing del aToken, sin mecanismo de fee). |
| ¿Hooks de Uniswap v4? | Solo en Corridors Fase C (§14), con su gate de volumen. | Parmelia consume liquidez, no la vende: swaps rutean a pools públicos, Earn no toca AMMs, pagos tampoco. El único caso donde un hook crea valor propio es el netting de flujos recurrentes con pools propios — y eso exige ≥$100k/mes de volumen interno probado en las Fases A/B primero. |

## 14. Corridors / recorr-hook (evaluación — sin cambios)

Veredicto vigente: prometedor como diferencial, NO listo. Camino por fases:
**Fase A** matching off-chain de flujos opuestos entre usuarios (transferencias
internas + swap del neto vía §5 — sin contratos nuevos, captura ~80% del valor);
**Fase B** contrato de settlement simple con límites firmados; **Fase C** hook
v4 con pools propios SOLO con ≥ ~$100k/mes de volumen interno estable. Los
requisitos del PoC (sin `tx.origin`, roles solver/operator, expiración de
intents, caps de dynamic fees, suite de invariantes) siguen siendo la vara.

## 15. Referencias (verificadas jul-2026)

- Aave — direcciones oficiales por red (Pool Arbitrum `0x794a…14aD`):
  https://aave.com/docs/resources/addresses
- Aave — mercado Arbitrum v3 (USDC nativo, ~$168M supplied, APY vivo):
  https://app.aave.com/?marketName=proto_arbitrum_v3 · histórico:
  https://aavescan.com/arbitrum-v3
- Aave — testnet Arbitrum Sepolia + faucet:
  https://bridge-testnet.aave.com/faucet/?marketName=proto_arbitrum_sepolia_v3
- Compound v3 — mercado USDC nativo en Arbitrum (proposal 178):
  https://www.tally.xyz/gov/compound/proposal/178 · https://docs.compound.finance/
- TopazeBlue/Bancor — "Impermanent Loss in Uniswap v3" (nov-2021; $199M fees vs
  $260M IL; 49.5% de LPs negativos vs HODL):
  https://cryptobriefing.com/half-uniswap-v3-liquidity-providers-underperform-holding-bancor-study/
  · paper: https://arxiv.org/pdf/2111.09192 · análisis posterior:
  https://epubs.siam.org/doi/10.1137/23M1606149
- Uniswap v3/v4 (swaps, implementado): docs.uniswap.org (deployments v3/v4).

## 16. Changelog

**v1 (jun-2026):** diseño de 5 módulos; swaps y fees implementados; Earn
diseñado como LP v3 con 3 niveles de riesgo (no implementado); corridors por
fases. **v2.0 (este documento):** cierre del debate de Earn — el diagnóstico
(dos productos mezclados), la decisión (Aave v3 supply USDC, cero contratos
nuevos, fee 0 con gate matemático), invariantes E1-E8, modos de fallo,
arquitectura de implementación completa y preguntas cerradas. La mecánica LP
anterior queda archivada en el historial de git y citada como base de la
eventual Fase 3 "Inversión". Cross-chain movido definitivamente a
`CROSSCHAIN_DESIGN.md` v2.0.

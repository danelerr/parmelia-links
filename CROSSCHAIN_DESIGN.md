# Parmelia Cross-Chain - Diseño y decisiones

> Diseño autoritativo del módulo cross-chain de Parmelia (USDC). Reemplaza y
> amplía el boceto de `DEFI_DESIGN.md` §1. Estado: **diseñado, no implementado**.
> Fecha: junio 2026.
>
> Datos de fees/mecánica verificados contra documentación primaria (Circle, Across,
> LI.FI) - ver §11 Referencias. Cualquier número debe re-cotizarse en vivo antes
> de fijar la fee de producto.
>
> **v1.1 (aprobado para codear):** `maxFee` sin fallback silencioso (§5),
> `destinationCaller = bytes32(0)` en v1 (§3, §5), campos CCTP en la tabla (§7), y
> tiempos siempre como estimados (§4).

---

## 0. Decisiones clave (resumen ejecutivo)

| Decisión | Elección | Por qué |
|---|---|---|
| Alcance v1 | **Solo USDC**, solo chains soportadas por CCTP v2 | El caso de Parmelia es USDC↔USDC. ETH/WBTC cross-chain: fuera de v1. |
| Rail principal | **CCTP v2 directo** (sin Across/LI.FI/Uniswap encima) | USDC nativo (no wrapped), el más barato, y Parmelia captura su fee sin compartir margen. |
| Relayer | **Propio**, para ejecutar el mint en destino | Evita el fee fijo del Forwarding Service ($0.20), que mata pagos pequeños. Reusa el patrón relayer+indexer existente. |
| Modo CCTP | **Fast por default** en outbound desde Arbitrum; **Standard** opcional ("Económico") | Standard depende de la finalidad de la chain origen (lento). Fast = 8-20s. |
| Captura de fee | **Router propio en una sola tx** (fee-skim + `depositForBurn`) | Atómico: nunca se cobra el fee sin que ocurra el burn. Extiende el patrón ya auditado de `ParmeliaPaymentRouter`. |
| Across | **Fallback / benchmark**, y candidato para inbound desde wallets externas | Requiere API key + `integratorId` (el endpoint legacy keyless es deuda técnica). No depender de él para USDC→USDC si CCTP cubre la ruta. |
| LI.FI | **Solo fallback** (chain no-CCTP, token no-USDC) | Cobra 0.25% + tu fee → apila fees. Inaceptable como default de pagos. |
| Uniswap cross-chain | **No es un rail** | Es Across + routing de Uniswap por debajo; sirve para "token distinto → USDC", fase posterior. |
| Persistencia | Tabla nueva **`crosschain_operations`** | Semántica distinta de `pending_payments` (multi-paso, multi-chain, horas de vida). No mezclar. |
| Custodia | **Cero.** El relayer solo paga gas | Ver §3 (modelo de seguridad). |

---

## 1. Alcance y objetivo

Cross-chain **no es el core** de Parmelia. Es una capa de flexibilidad sobre una
base Arbitrum-first, con tres objetivos:

1. **Inbound (Flow A):** una wallet externa / red externa paga a un usuario
   Parmelia, que recibe USDC nativo en su smart account de Arbitrum.
2. **Outbound (Flow B):** un usuario Parmelia envía USDC desde Arbitrum hacia
   otra chain.
3. **Monetización:** Parmelia cobra una fee de producto en el flujo outbound.

**v1 es estrictamente USDC-only** y solo entre chains soportadas por CCTP v2.
Parmelia maneja USDC, ETH y WBTC internamente, pero el cross-chain v1 no toca
ETH/WBTC.

---

## 2. Por qué CCTP v2 directo

Como ambos flujos son **USDC nativo → USDC nativo**, el primitivo correcto es
CCTP (Circle Cross-Chain Transfer Protocol), no un bridge de liquidez genérico ni
un agregador de swaps:

- **USDC nativo, no wrapped.** CCTP quema USDC en origen y acuña USDC nativo 1:1
  en destino (burn-and-mint). El receptor nunca recibe USDC.e, axlUSDC ni wrappers
  raros.
- **El más barato.** Standard es gratis; Fast cobra 0-14 bps (ver §4). No hay fee
  de liquidez ni de relayer de terceros.
- **Sin apilar fees.** Usar Across/LI.FI significaría su fee **más** la de Parmelia
  (doble fee). Con CCTP directo las únicas fees son CCTP + gas + la de Parmelia, y
  el margen lo captura Parmelia. Decisivo para el flujo monetizado.
- **Sin dependencia de API key.** Elimina la deuda del endpoint legacy de Across.
- **Encaja con la arquitectura existente.** Parmelia ya corre un relayer EOA + un
  indexer/cron que vigila logs y reconcilia (`runIndexer`, `runRouterWatcher`). El
  flujo CCTP es el mismo patrón: vigilar el burn → pollear la atestación de Circle
  (Iris, sin key) → enviar el mint.

---

## 3. Modelo de seguridad (verificado)

Tres propiedades de CCTP v2, confirmadas en la documentación e implementación de
Circle, hacen este diseño seguro frente a las pérdidas históricas:

1. **El relayer no puede robar ni desviar fondos.** El `mintRecipient` queda
   **fijado dentro del `depositForBurn`**, firmado por el pagador en la chain
   origen. El relayer solo llama `receiveMessage`, que acuña al destinatario ya
   comprometido. El relayer no elige destino ni monto.
2. **Un transfer quemado NUNCA se pierde.** `receiveMessage` es **permissionless**:
   una vez que Iris firma la atestación, *cualquiera* con gas en destino puede
   completar el mint, y la atestación es válida indefinidamente. Si el relayer de
   Parmelia se cae, los fondos no quedan atrapados - los completa otro relayer o el
   propio usuario. Un "burn hecho, mint pendiente" es **recuperable**, no una
   pérdida.
3. **Doble-mint imposible a nivel de protocolo.** El destino marca el nonce del
   mensaje como usado; un segundo `receiveMessage` revierte. La idempotencia del
   relayer es defensa en profundidad, no la única barrera.

Consecuencia de diseño: **el estado `refunded` casi no aplica.** Un burn siempre
puede acuñar. Los únicos fallos reales son (a) el `depositForBurn` revierte → no
pasó nada, o (b) en Fast el `maxFee` queda por debajo del fee actual → a nivel de
protocolo caería a Standard; el producto lo evita recotizando y **no firmando** si
la quote venció (§5). El trabajo del relayer es *garantizar que el mint ocurra*;
esencialmente no puede fallar de forma permanente.

Para preservar estas propiedades, en v1 `depositForBurn` usa
**`destinationCaller = bytes32(0)`** (cualquiera puede acuñar). Fijar un caller
específico restringiría `receiveMessage` a esa dirección y rompería tanto el
permissionless como el `manual_complete`.

---

## 4. Fees y velocidad (verificado - re-cotizar en vivo)

**CCTP (Circle):**

| Modo | Fee de protocolo | Velocidad | Uso |
|---|---|---|---|
| **Standard** | **Gratis (0 bps)** | Finalidad dura de la chain origen (minutos; ~13-19 min típico) | Modo "Económico" cuando la origen es rápida o el usuario puede esperar |
| **Fast** | **0-14 bps** según chain origen | **~8-20s (estimado, no garantizado)** | Default para outbound desde Arbitrum |

Fees Fast por chain origen relevantes: Ethereum/Solana 1 bps; **Arbitrum/Base/OP
Mainnet/World 1.3 bps**; Linea 11 bps; Starknet 14 bps. Se descuenta del monto al
acuñar en destino.

**Costo total de una operación** = fee CCTP (si Fast) + gas en origen + gas del
mint en destino (lo paga el relayer) + **fee de Parmelia**. Ejemplo medido en vivo
(Base→Arbitrum, 10 USDC, vía Across para referencia): ~$0.006 + 2s; CCTP Fast
1.3 bps sería ~$0.00013 + gas. Para montos pequeños, el componente fijo de gas
domina sobre el porcentaje en cualquier rail.

**Circle Forwarding Service** (NO usar en v1): elimina la necesidad de correr el
relayer, pero cobra **$0.20 fijo + gas dinámico**, *además* del fee de protocolo.
$0.20 sobre un pago de $10 = 2% → daña pagos pequeños. Por eso v1 corre relayer
propio.

**Comparativa de terceros (por qué quedan como fallback):**

| Opción | Fee | Notas |
|---|---|---|
| **Across** | Relayer fee dinámica (~0.06% medido en Base→Arb USDC) | Rápido (~2-3s). Requiere API key + `integratorId`. `/suggested-fees` es legacy. |
| **LI.FI** | **0.25%** + tu fee encima | Apila fees. Solo fallback no-USDC / chain no-CCTP. |
| **Uniswap cross-chain** | Across + routing | No es un rail; es Across por debajo. 9 chains EVM. Para "token → USDC", futuro. |

---

## 5. Flow B - Outbound (PRIORITARIO: aquí Parmelia monetiza)

Usuario Parmelia envía USDC desde su smart account en Arbitrum a una dirección en
otra chain CCTP.

1. Usuario elige chain destino + dirección destino + monto, y modo (Rápido/Económico).
2. Backend valida server-side: token en whitelist, `chainId`/CCTP domain válidos,
   `recipient` válido. Cotiza fee Parmelia + fee CCTP estimada. Registra la
   operación (`quoted`) **antes** de firmar.
3. **UserOp en Arbitrum (una sola tx, vía `CrosschainRouter` propio):**
   1. cobra la fee Parmelia hacia treasury (o la descuenta del monto);
   2. ejecuta `depositForBurn(neto, destDomain, mintRecipient, USDC, destinationCaller, maxFee, minFinalityThreshold)`
      con `destinationCaller = bytes32(0)` → `receiveMessage` permissionless + `manual_complete`;
   3. emite evento de operación.
   - Firmado con la **passkey** (los fondos salen de la smart account del usuario).
4. Relayer detecta el burn → pollea la atestación de Iris → ejecuta `receiveMessage`
   en destino → el destinatario recibe USDC nativo.

Atómico: la fee y el burn ocurren en la misma tx; nunca se cobra fee sin burn.

**`maxFee` (sin fallback silencioso):** sale de un quote en vivo con buffer pequeño.
**No firmar** si la quote venció o si el `maxFee` aceptado por el usuario no cubre
la fee Fast actual: en ese caso **recotizar** (re-confirmar con el usuario) o
**fallar antes del burn**. El modo Económico (Standard) es una **elección
explícita** del usuario, nunca una degradación silenciosa de Fast.

---

## 6. Flow A - Inbound (MÁS DIFÍCIL: no es simétrico al outbound)

Una wallet externa paga a un usuario Parmelia; el receptor recibe en Arbitrum.

**El riesgo principal del módulo está aquí.** A diferencia del outbound (donde
Parmelia controla la smart account y firma un UserOp), en inbound una **wallet
externa tiene que firmar `depositForBurn`**, y eso **no es un "enviar USDC"
normal**: un transfer plano de USDC a una dirección **no bridgea**. Requiere que
Parmelia hostee una dApp de checkout que:

- conecte la wallet externa (wagmi/walletconnect - única pantalla con wallet externa);
- haga `approve` de USDC al TokenMessenger;
- construya y haga firmar el `depositForBurn` con `mintRecipient` = smart account
  del receptor en Arbitrum;
- muestre sin ocultar: monto enviado, monto recibido, fee Parmelia (si aplica),
  fee CCTP/Fast (si aplica), gas estimado, tiempo estimado.

Luego el mismo relayer completa el mint.

**Decisiones de Flow A:**
- Es un **hito aparte y posterior** a Flow B, no "lo mismo al revés".
- Modo: si la chain origen tiene Standard rápido, usar Standard; si no y la UX
  importa, Fast.
- **Reconsiderar Across para inbound**: su modelo de intents es más amigable para
  "pagador externo que solo quiere pagar". Decidir con el benchmark (§10), no por
  simetría con el outbound.
- Fee en inbound: si complica, dejarlo **sin fee** en v1 o cobrarlo explícito vía
  router de origen. Nunca ocultar fees.

---

## 7. Persistencia: `crosschain_operations`

Tabla nueva, separada de `pending_payments` (semántica multi-paso/multi-chain).

Campos mínimos:

```
op_id                   text  PK
uid                     text
direction               inbound | outbound
provider                cctp                 -- (across en fallback futuro)
cctp_mode               standard | fast
source_chain_id         int                  -- EVM chainId
destination_chain_id    int                  -- EVM chainId
source_domain           int                  -- dominio CCTP (distinto del chainId)
destination_domain      int                  -- dominio CCTP (distinto del chainId)
destination_caller      text                 -- bytes32(0) en v1 (permissionless)
source_tx_hash          text
destination_tx_hash     text
message_nonce           text                 -- nonce del mensaje CCTP, para reconciliar el mint
message_bytes           text                 -- opcional: mensaje crudo (o re-fetch de Iris)
attestation             text                 -- opcional: atestación de Iris (necesaria para receiveMessage / manual_complete)
token                   USDC
amount_in               text
parmelia_fee            text
max_fee                 text                 -- maxFee usado en depositForBurn (Fast)
min_finality_threshold  int                  -- umbral de finalidad (Fast bajo / Standard alto)
cctp_fee_estimated      text
amount_out_expected     text
recipient               text
status                  text
status_detail           text
created_at              text
updated_at              text
completed_at            text
```

---

## 8. Máquina de estados

```
quoted -> pending_signature -> submitted -> waiting_attestation -> minting -> completed
```

Ramas de error (simplificadas por §3 - un burn no se pierde):

```
failed         -- el depositForBurn revirtió: no pasó nada
expired         -- quote venció antes de firmar
recoverable     -- burn hecho, mint pendiente: reintentar el mint; manual_complete por
                cualquiera (receiveMessage es permissionless)
needs_support   -- intervención manual (caso raro)
```

No existe `refunded` real: la recuperación de un burn siempre es "completar el
mint", nunca devolver. Como último recurso, `receiveMessage` es permissionless y
el propio usuario puede completarlo.

---

## 9. Reglas de seguridad y operación

- **No custodiar** fondos en tránsito. El relayer solo paga gas.
- **Whitelist estricta** de tokens; rechazar fuera de ella.
- **No construir calldata desde input libre** del cliente. Validar server-side
  `chainId`, address del token, CCTP domain y `recipient`.
- **Registrar la operación antes** de firmar/enviar.
- **Relayer idempotente**: si el nonce ya se acuñó, no repetir (el protocolo
  además lo impide).
- **Manejar reintentos** y **alertar** si una operación queda en
  `waiting_attestation`/`minting` más de X minutos.
- No usar `tx.origin`. No mezclar con `pending_payments`. No prometer tiempos
  exactos (usar estimados). No cobrar fees ocultas.
- **Superficie de gas-ops:** el relayer necesita gas nativo en **cada** chain
  destino. v1: **limitar a 1-2 chains destino**. Monitorear y recargar saldos. Si
  la key del relayer se filtra, el riesgo es el gas, no el principal de usuarios.
  Ofrecer fallback "completar yo mismo" (permissionless) si el relayer está caído.
- **Contratos de Circle**: fijar las direcciones auditadas oficiales; no forkear
  (hubo bugs históricos de mint en CCTP).

---

## 10. Orden de implementación

1. **`CrosschainRouter` en Arbitrum** (fee-skim + `depositForBurn` atómico) +
   relayer de mint para **una** chain destino (ej. Base). **Flow B, Fast.**
2. Tracking robusto (`crosschain_operations`) + máquina de estados (§8).
3. **Benchmark** CCTP Fast vs Across en rutas reales de Parmelia.
4. **Flow A inbound** - y decidir con datos si para inbound se usa
   CCTP-checkout-hospedado o Across.
5. Recién entonces: ¿Across queda como fallback activo?

**No implementar todavía:** ETH/WBTC cross-chain, LI.FI como default, Uniswap
cross-chain, Forwarding Service como default, multichain core, migración de chain.

---

## 11. Referencias (verificadas, junio 2026)

- Circle CCTP - Fees: https://developers.circle.com/cctp/concepts/fees
  (Standard gratis; Fast 0-14 bps por chain; se descuenta al acuñar).
- Circle CCTP - Forwarding Service: https://developers.circle.com/cctp/concepts/forwarding-service
  ($0.20 fijo + gas, además del fee de protocolo).
- Circle CCTP v2 - mecánica (receiveMessage permissionless, Fast 8-20s, maxFee /
  minFinalityThreshold): https://eco.com/support/en/articles/11813797-circle-cctp-v2-native-usdc-across-13-chains
- Circle TokenMessenger / depositForBurn (mintRecipient): https://github.com/circlefin/evm-cctp-contracts/blob/master/src/TokenMessenger.sol
- Across - API Reference (requiere Bearer + integratorId; suggested-fees legacy):
  https://docs.across.to/api-reference
- LI.FI - Fees & Monetization (0.25% service fee + fee de integrador):
  https://docs.li.fi/faqs/fees-monetization
- Uniswap - What are crosschain swaps (powered by Across): https://support.uniswap.org/hc/en-us/articles/43793128689549-What-are-crosschain-swaps

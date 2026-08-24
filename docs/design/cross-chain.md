# GatoPago Cross-Chain — Diseño definitivo (v2.0)

> Diseño autoritativo del módulo cross-chain de GatoPago (USDC). Estado del
> código: **implementado y endurecido** (contrato desplegado en Sepolia, server
> completo, checkout público, relayer con reconciliación); pendiente de
> activación operativa — ver §11. Fecha: julio 2026. Historia de versiones al
> final (§14).
> El código, la configuración de red y la evidencia E2E fechada prevalecen sobre
> cualquier afirmación de disponibilidad de este diseño.
>
> Este documento CIERRA el debate de arquitectura. Las decisiones de §2, §3 y
> §13 no se re-litigan salvo que cambie un hecho externo (pricing de Circle,
> aparición de un dominio CCTP nuevo, cambio de alcance de producto). Si una
> conversación futura vuelve a abrir "¿y si usamos X?", la respuesta está en §13.

---

## 0. Veredicto

Después de semanas de debate (CCTP vs Across vs LI.FI vs Forwarding, relayer
propio vs gestionado, router vs llamadas directas), la conclusión fría es que
**la arquitectura elegida era correcta desde v1.1 y sigue siéndolo**:

> **CCTP v2 directo, router propio de fee-skim en origen, relayer propio
> best-effort para el mint, `receiveMessage` permissionless, registro en D1
> antes de firmar.**

Lo que mantenía la sensación de "no encontramos la manera ideal" no era el rail.
Eran cuatro huecos del diseño original, todos ya cerrados:

1. **No estaban escritos los invariantes** (§4). Sin invariantes explícitos,
   cada caso borde reabría la arquitectura entera.
2. **No había tabla de modos de fallo con su recuperación** (§7). El miedo a
   "¿y si se pierde un burn?" se respondía con intuición en vez de con el hecho
   de que un burn atestado es completable por cualquiera, para siempre.
3. **La operación (gas, alertas, runbooks) estaba subespecificada** (§10). El
   costo real del módulo no es el código: es tener gas del relayer en cada
   destino y saber qué hacer cuando algo se atasca.
4. **No había procedimiento de decisión para lo futuro** (§2.1). "¿Agregamos
   Polygon?" o "¿y tokens que no son USDC?" no deben reabrir el debate: tienen
   una regla.

El módulo hoy es **seguro por construcción** (no por vigilancia): el peor caso
alcanzable es *demora*, nunca pérdida ni custodia. Lo que falta no es diseño —
es activación operativa (§11) y tres mejoras de producto por fases (§12).

---

## 1. Alcance y no-objetivos

Cross-chain **no es el core** de GatoPago; es una capa de flexibilidad sobre una
base Arbitrum-first. Tres objetivos:

1. **Outbound (Flow B):** un usuario GatoPago envía USDC desde Arbitrum hacia
   otra chain CCTP. Aquí GatoPago monetiza (fee con cap duro 1%).
2. **Inbound (Flow A):** una wallet externa paga a un usuario GatoPago desde
   otra chain; el receptor recibe USDC nativo en su smart account de Arbitrum.
   Checkout público `/cc/:username`. Sin fee de GatoPago en v1.
3. **Confiabilidad:** ninguna operación puede perder fondos ni requerir
   confianza en el relayer.

**No-objetivos permanentes de esta versión** (cambiarlos exige nuevo diseño):
ETH/WBTC cross-chain; chains fuera de CCTP v2; agregadores (LI.FI) como default;
Uniswap cross-chain como rail; custodia o pooling de fondos en tránsito;
multichain core (la app sigue siendo mono-chain con CHAIN_KEY); migración de
chain vía redeploy.

**Decisión de producto vigente:** cross-chain es **capa avanzada**, no el método
principal de depósito (ese es Arbitrum directo + a futuro fiat/Binance).

---

## 2. La decisión del rail: CCTP v2 directo

Para USDC↔USDC entre dominios CCTP, CCTP v2 **no es una opción entre varias: es
el primitivo canónico**. Es burn-and-mint operado por el emisor del activo
(Circle): quema USDC nativo en origen y acuña USDC nativo 1:1 en destino. Todo
lo demás (Across, LI.FI, "Uniswap cross-chain") es una capa de liquidez o
agregación ENCIMA de pools o del propio CCTP, que añade riesgo de contraparte,
fees apiladas y dependencias de API — sin aportar nada cuando origen y destino
son el mismo activo canónico.

Concretamente:

- **USDC nativo, no wrapped.** El receptor nunca recibe USDC.e/axlUSDC.
- **El más barato posible:** Standard es gratis; Fast cuesta 1.3 bps desde
  Arbitrum/Base. No hay fee de liquidez ni de relayer de terceros, así que el
  margen del producto lo captura GatoPago completo.
- **Sin API keys** (Iris es REST público, ~35 req/s) ni contratos de terceros
  que auditar: las direcciones de TokenMessenger/MessageTransmitter v2 son
  deterministas y auditadas por Circle.
- **Encaja con la infraestructura existente:** el patrón relayer-EOA + job
  durable + watcher ya existe para el indexer y el PaymentRouter; CCTP usa el
  mismo scheduler dirigido por estado.

### 2.1 Procedimiento de decisión para casos futuros

Para que nadie re-litigue el rail:

| Pregunta | Regla |
|---|---|
| ¿USDC entre dos dominios CCTP v2? | **CCTP v2 directo. Siempre.** |
| ¿Chain sin dominio CCTP? | Fuera de alcance. No se soporta hasta que Circle la agregue o el producto lo exija con volumen real — en ese caso evaluar agregador COMO EXCEPCIÓN documentada. |
| ¿Token que no es USDC? | Fuera de alcance (no-objetivo). La ruta futura es "swap interno a USDC en Arbitrum → cross-chain USDC", no un rail multi-token. |
| ¿Aparece un rail "mejor"? | Solo se reevalúa si supera a CCTP en LAS TRES: costo, riesgo (canónico vs liquidez) y dependencia (sin API key). Ninguno de los conocidos lo hace. |

---

## 3. Por qué NO las alternativas (con números)

| Opción | Fee | Problema decisivo |
|---|---|---|
| **Across** | ~6 bps dinámico + requiere API key/`integratorId` | Rail de intents sobre liquidez de terceros. Su única ventaja (fill en ~2s vs ~8-20s de Fast) es inmaterial para un checkout de pagos. Fee apilada sobre la nuestra. **Se retira** (§12, Fase 1): el endpoint legacy `/bridge` y la ruta de depósito vía UI de Across quedan obsoletos frente al checkout `/cc` propio. |
| **LI.FI** | 0.25% + fee de integrador encima | Apila 25 bps sobre el 1.3 bps de CCTP: ~20x más caro. Solo tendría sentido para no-USDC/no-CCTP, que es no-objetivo. |
| **Circle Forwarding Service** | $0.20 fijo + gas, además del fee de protocolo | $0.20 sobre un pago de $10 = 2%. Mata el ticket típico de GatoPago. Solo se reevaluaría si el costo operativo del relayer propio superara con claridad su costo (§10). |
| **"Uniswap cross-chain"** | Across + routing | No es un rail: es Across por debajo. Irrelevante para USDC→USDC. |
| **Sin relayer (el usuario mintea)** | 0 | Requiere que el usuario tenga gas en la red destino: destruye la UX que el módulo existe para dar. Queda como *fallback* natural gracias al permissionless (§7). |
| **`destinationCaller` restringido + red de relayers de terceros** | variable | Rompe el permissionless de `receiveMessage` → rompe el invariante I1 (un burn nunca se pierde). Inaceptable. |

**El relayer propio, bien entendido:** gracias a que `receiveMessage` es
permissionless y la atestación no expira, el relayer de GatoPago **no es un
componente de confianza ni de liveness crítica — es un acelerador best-effort**.
Si muere, el peor caso es demora hasta que se recupere, otro relayer mintee, o
el propio usuario complete el mint. Su costo marginal es el gas del mint en
destino (~$0.001-0.01 en L2s). Esta reformulación es la que disuelve la mitad
del debate histórico: no estamos eligiendo "en quién confiar", porque el diseño
no confía en nadie.

---

## 4. Invariantes del sistema

Estos son los hechos que el código garantiza y que cualquier cambio futuro debe
preservar. Cada uno tiene su enforcement señalado.

| # | Invariante | Dónde se garantiza |
|---|---|---|
| I1 | **Un burn nunca se pierde.** Toda quema atestada es completable por cualquiera, para siempre. | `destinationCaller = bytes32(0)` en todo `depositForBurn`; atestación de Iris sin expiración. |
| I2 | **La fee de GatoPago solo se cobra si el burn ocurre.** | Atomicidad de `ParmeliaCrosschainRouter.bridgeUSDC` (fee-skim + burn en una tx); cap 1% on-chain. |
| I3 | **El relayer no puede robar ni desviar.** | `mintRecipient` queda fijado dentro del burn firmado en origen; `receiveMessage` solo acuña a ese destinatario. |
| I4 | **Toda operación existe en D1 antes de que exista el burn.** | Outbound: `/crosschain/prepare` crea la fila `quoted` antes de devolver la UserOp; `/pay/submit` registra el tx ANTES de esperar el receipt. Inbound: `/inbound/prepare` crea `pending_signature` antes de devolver las txs. |
| I5 | **Un burn tx ↔ una operación.** | Índice único de `source_tx_hash` (migración 0006) + dedupe en `/inbound/register`. |
| I6 | **Solo se mintean burns que corresponden a su operación.** | `validateCctpMessage`: dominios, `mintRecipient` y monto del mensaje CCTP contra la fila, antes de gastar gas. Mismatch → `needs_support`, nunca mint. |
| I7 | **Los estados son monótonos; `completed` es terminal.** | Guard en `updateCrosschainOp` (CAS + prohibición de salir de `completed`). |
| I8 | **Disponibilidad honesta (fail-closed).** No se ofrece una ruta cuyo gas de relayer no se pudo VERIFICAR. | `relayerGasStatus` tri-estado; `unknown` cuenta como no disponible en config y prepare. |
| I9 | **Nunca degradación silenciosa Fast→Standard.** | `maxFee` sale de una quote viva; si no cubre, se recotiza o no se firma. Standard es elección explícita del usuario. |
| I10 | **Cero custodia.** El router no retiene fondos entre transacciones; el relayer solo paga gas. | Diseño del contrato (+ fuzz de conservación: el router nunca queda con saldo). |

---

## 5. Arquitectura (cinco capas)

### 5.1 Contrato (origen)
`ParmeliaCrosschainRouter` en Arbitrum (`0x0816d133…D777` en Sepolia): valida
`opId != 0`, monto > 0, recipient != 0, fee ≤ 1%; skim de fee al treasury; pull
del neto; `forceApprove` + `depositForBurn` al TokenMessenger v2; evento
`CrosschainSent` indexado por `opId`. Pausable, Ownable2Step, sin custodia.
En destino NO hay contrato propio: el mint es `receiveMessage` del
MessageTransmitter de Circle.

### 5.2 Server (Cloudflare Worker)
- **Rutas outbound** (auth): `GET /crosschain/config` (destinos verificados),
  `POST /crosschain/quote` (determinista, sin estado), `POST /crosschain/prepare`
  (valida, registra `quoted`, arma la UserOp approve+bridge), y el submit va por
  el pipeline general `/pay/submit` (claim atómico, `UserOperationEvent` como
  verdad, tx registrado pre-receipt). `GET /crosschain/status/:opId` para el
  progreso del dueño.
- **Rutas inbound** (públicas, rate-limited por IP): `GET /inbound/config`,
  `POST /inbound/prepare` (resuelve username → registra `pending_signature` →
  devuelve las DOS txs crudas: approve al TokenMessenger + `depositForBurn`),
  `POST /inbound/register` (adjunta el burn tx con dedupe I5 y CAS),
  `GET /inbound/status/:opId` (polling del checkout).
- **Relayer** (job que sólo se reprograma mientras haya ops in-flight, con lease
  anti-solapamiento): rota por `updated_at` (sin inanición), consulta Iris por
  `sourceTxHash`, valida el mensaje (I6), mintea con idempotencia (receipt del
  `destinationTxHash` antes de re-enviar), contador de intentos con tope (20 →
  `needs_support`), TTLs (abandonadas 24h → `expired`; in-flight 7d →
  `needs_support`).

### 5.3 Datos
`crosschain_operations` (STRICT + FK + CHECK, migración 0006): identidad de la
op, dominios/chains, montos y fees, `message_bytes`/`attestation` cacheados,
`attempt_count`/`last_error` de operabilidad, timestamps. Separada de
`pending_payments` a propósito (vida de horas, multi-chain, multi-paso).

### 5.4 Cliente
- **`CrosschainSend` (`/crosschain`, outbound):** monto con `AmountInput`,
  selector de red verificada, quote con cancelación de races, **hoja de
  confirmación** (red, dirección, monto, fees, ETA, advertencia de
  irreversibilidad), firma con passkey, éxito con ETA. *Gap pendiente (Fase 0):
  pollear `GET /crosschain/status/:opId` tras el envío para mostrar
  burn→attestation→mint en vivo en vez de depender solo del push.*
- **`CrosschainReceive` (`/cc/:username`, checkout público):** wallet externa
  vía `window.ethereum` (sin viem, chunk mínimo), switch/add de red, approve +
  burn con receipts validados, registro del tx, polling de estado hasta
  `completed`.
- **`Receive` (`/receive`):** Arbitrum directo (QR + dirección) como método
  principal; el link `/cc` como opción avanzada. SIEMPRE advierte "solo USDC en
  Arbitrum" para el path directo.

### 5.5 Operación
La capa que faltaba especificar. Ver §10: presupuesto de gas por destino,
alertas, runbooks (incluido `manual_complete`), y el criterio para agregar
chains (§12.1).

---

## 6. Máquina de estados (autoritativa)

```
outbound:  quoted ──────────────┐
inbound:   pending_signature ───┴→ submitted → waiting_attestation → minting → completed
```

Ramas terminales y de mantenimiento:

| Estado | Significado | Cómo se llega | Salida |
|---|---|---|---|
| `failed` | El burn revirtió o la UserOp falló: **no se movió nada**. | `/pay/submit` (receipt/`UserOperationEvent`), reconciliador. | Terminal. |
| `expired` | Abandonada antes de cualquier burn (nunca firmada/registrada). | TTL 24h sobre `quoted`/`pending_signature`. | Terminal. No retiene fondos. |
| `recoverable` | Burn hecho, mint revertido: reintentable. | Mint con receipt `reverted`. | Relayer reintenta; manual (§10.3). |
| `needs_support` | Parqueada: tope de intentos, mensaje que no corresponde (I6), o in-flight > 7 días. | Relayer. | Runbook manual (§10.3). El burn sigue completable (I1). |

No existe `refunded`: la recuperación de un burn siempre es *completar el mint*,
nunca devolver. Estados monótonos, `completed` terminal (I7).

---

## 7. Modos de fallo y recuperación

| Modo de fallo | Detección | Manejo automático | Manual |
|---|---|---|---|
| El burn revierte en origen | `UserOperationEvent(success=false)` o receipt reverted | Op → `failed`; nada se movió; fee no cobrada (I2) | — |
| Worker muere tras difundir el burn | Fila `submitted` con tx (I4) | El reconciliador de pagos liquida la parte contable; el relayer continúa el mint | — |
| Iris caído / atestación lenta | Op se queda en `waiting_attestation` | Rotación evita inanición; alarma con backoff mientras la op siga activa | Alerta si > 30 min (§10.2) |
| Relayer sin gas en destino | `relayerGasStatus` | Rutas NUEVAS ocultas (I8); alerta `crosschain_relayer_low_gas` para in-flight | Fondear la EOA; o el usuario/quien sea mintea (I1) |
| Mint revierte repetidamente | Contador de intentos | Tope 20 → `needs_support` | Runbook §10.3 |
| Tx registrado no corresponde a la op (abuso del endpoint público) | `validateCctpMessage` (I6) | `needs_support` con detalle "mismatch"; sin mint, sin gas gastado | Ignorar (es spam); el dedupe I5 y el rate limit acotan el volumen |
| Usuario escribe mal el destinatario outbound | — | **Irreversible por diseño** (así funciona un burn/mint). Mitigación: hoja de confirmación obligatoria | Soporte solo puede verificar, no recuperar |
| Transfer plano de USDC a la dirección del usuario en OTRA red (sin checkout) | Fuera del sistema; el indexer solo ve Arbitrum | Ninguno en v2.0 | Rescate posible por CREATE2 (misma dirección en toda red): desplegar infra + cuenta allí y bridgear. Fase 3 lo automatiza (§12) |
| Reorg en origen antes de la atestación | Iris no atesta un tx huérfano | La op se queda esperando; si el tx re-mina, sigue; si no, TTL | — |

---

## 8. Fees y velocidad (verificado jun-2026; re-cotizar en vivo antes de fijar el fee de producto)

| Modo | Fee de protocolo | Velocidad | Uso |
|---|---|---|---|
| **Fast** (`minFinalityThreshold=1000`) | 0-14 bps según origen (**Arbitrum/Base: 1.3 bps**) | ~8-20 s (estimado, no garantizado) | **Default** outbound e inbound |
| **Standard** (`minFinalityThreshold=2000`) | **Gratis** | Finalidad dura del origen (~13-19 min típico) | "Económico", elección explícita |

Costo total de una operación = fee CCTP (si Fast) + gas en origen (paymaster en
outbound; el pagador externo en inbound) + gas del mint en destino (el relayer)
+ fee de GatoPago (outbound; cap duro 1% on-chain y en server). El `maxFee` de
Fast sale de la quote viva con buffer pequeño (I9). Para montos pequeños el
componente fijo de gas domina sobre el porcentaje en cualquier rail — otra razón
por la que apilar fees de terceros es inaceptable.

**Matiz de finalidad por chain origen (verificado contra Circle, jul-2026):** la
velocidad del Standard la define la finalidad de la CHAIN ORIGEN. Las chains de
finalidad instantánea (Avalanche: Standard ~8s, 1 confirmación — ni figura en la
tabla de Fast porque no lo necesita) tienen outbound rápido GRATIS; las L2 de
Ethereum (Arbitrum/Base: Standard ~15-19 min, ~65 bloques de L1) necesitan Fast
(~1.3 bps) para ser rápidas como origen. Consecuencias: (a) el costo de 1.3 bps
del outbound desde Arbitrum es estructural, no un descuido — y es inmaterial
($0.13 por $1.000; se muestra en la quote y cabe dentro del fee de producto);
(b) para INBOUND lo que importa es la finalidad de la chain del PAGADOR, no la
nuestra — vivir en Avalanche no aceleraría los cobros desde Base/Ethereum;
(c) si algún día se evalúa una segunda red de settlement por razones de negocio
(MEJORAS #30), la finalidad instantánea de Avalanche cuenta como punto técnico
genuino a su favor.

---

## 9. Seguridad

- Modelo de amenaza del relayer: su clave comprometida arriesga **solo su gas**
  (I3, I10). No custodia, no puede desviar mints, no firma pagos de usuarios.
- Endpoints inbound públicos endurecidos: rate limit por IP, dedupe I5,
  validación de mensaje I6, formato de hash, CAS de estado.
- Server-side siempre: whitelist de token (USDC inmutable en el router),
  dominios/chains validados contra `CCTP_CHAINS`, montos recomputados, ningún
  calldata construido desde input libre del cliente.
- Direcciones de Circle fijadas de la documentación oficial (deterministas);
  **jamás forkear los contratos de CCTP** (historial de bugs de mint en forks).
- Kill switch (`CROSSCHAIN_PAUSED`) y flags por chain
  (`CROSSCHAIN_DISABLED_CHAINS`) para respuesta a incidentes.
- No usar `tx.origin`; no prometer tiempos exactos; no cobrar fees ocultas
  (la hoja de confirmación muestra monto, fees y ETA).

---

## 10. Operación

### 10.1 Gas del relayer (el costo real del módulo)
- El relayer (EOA `wallet-0x75`) necesita gas nativo en **cada chain destino
  ofrecida**. Recibir (inbound) NO requiere gas nuevo: mintea en Arbitrum, donde
  ya opera.
- Presupuesto: mint ≈ 120-200k gas; en L2s ≈ $0.001-0.01 por operación. Umbral
  de servicio: `CROSSCHAIN_MIN_RELAYER_GAS_WEI` (default 0.0005 ETH) — por
  debajo, la ruta se oculta (I8).
- Regla v1: **máximo 1-2 destinos activos** (Base primero). Cada destino nuevo
  es una obligación operativa permanente (§12.1).

### 10.2 Alertas (mínimas para operar)
- `crosschain_relayer_low_gas` — fondear la EOA en esa chain.
- Ops en `waiting_attestation`/`minting` > 30 min — revisar Iris/RPC.
- Cualquier op en `needs_support` — runbook §10.3 dentro de las 24h.
- `crosschain_message_mismatch` — probable abuso del endpoint público; verificar
  rate limits, no requiere acción sobre fondos.

### 10.3 Runbook: completar un mint a mano (`manual_complete`)
Válido para `recoverable`/`needs_support` con burn real (y como fallback si el
relayer está caído — cualquiera con gas puede ejecutarlo, I1):
1. Obtener mensaje y atestación (de la fila en D1, o re-fetch:
   `GET https://iris-api[-sandbox].circle.com/v2/messages/{sourceDomain}?transactionHash={burnTx}`).
2. En la chain destino:
   `cast send <MessageTransmitterV2> "receiveMessage(bytes,bytes)" <message> <attestation> --account <cualquiera-con-gas>`.
3. Verificar el `MintAndWithdraw`/Transfer al `mintRecipient`; marcar la op
   `completed` (o dejar que el relayer la detecte por el receipt idempotente).
4. Si `receiveMessage` revierte con nonce usado: el mint YA ocurrió — buscar el
   tx existente y cerrar la op.

### 10.4 RPCs
Testnet puede vivir con RPCs públicos (`DEFAULT_RPC_BY_CHAIN`). Producción exige
`CCTP_RPC_URLS` dedicados por chain destino: el gas-gating fail-closed (I8)
convierte un RPC caído en rutas ocultas — correcto para la seguridad, malo para
la disponibilidad si el RPC es público y flaky.

---

## 11. Checklist de activación (testnet) y de mainnet

**Activación (Fase 0, días):**
1. Redeploy del cliente (Vercel) → `/receive`, `/crosschain` y `/cc` en vivo
   (el Worker ya está; migraciones 0006-0008 ANTES del próximo deploy).
2. Fondear gas del relayer en Base Sepolia.
3. Smoke e2e de **Flow A** (recibir) — Flow B ya se probó e2e.
4. ✅ UI: `CrosschainSend` pollea `GET /crosschain/status/:opId` tras el envío
   (implementado 2026-07-03: tracking en vivo burn → atestación → entrega →
   "llegó", con link al explorer del destino y copy de reaseguro si demora —
   el push deja de ser el único canal).
5. Config: `GATOPAGO_CROSSCHAIN_FEE_BPS` (decidir 0 vs 30-50 bps), flags.

Con el punto 4 hecho, **todo el flujo cross-chain está implementado en código**
(server + relayer + checkout inbound + UI outbound con tracking); los puntos
1-3 y 5 son activación operativa, no desarrollo.

**Mainnet (además de los gates generales del proyecto):**
1. Verificar direcciones y dominios CCTP v2 **mainnet** contra
   developers.circle.com/cctp y registrar fecha/fuente en `shared/networks.ts`
   (las direcciones son deterministas, verificar igual).
2. Iris producción (`iris-api.circle.com`) — ya se selecciona por chainId.
3. `CCTP_RPC_URLS` dedicados; gas del relayer en cada destino mainnet.
4. Habilitar destinos gradualmente (Base primero), `CROSSCHAIN_DISABLED_CHAINS`
   para el resto.
5. Smoke e2e de ambos flujos con montos reales pequeños, documentado con fecha.
6. Alertas de §10.2 conectadas.

---

## 12. Roadmap por fases

- **Fase 0 — Activación** (§11). Sin código nuevo salvo el polling de estado en
  `CrosschainSend`.
- **Fase 1 — Consolidación:** retirar Across por completo (endpoint legacy
  `/bridge` + la ruta de depósito de `Deposit.tsx` que manda a la UI de Across)
  una vez que Flow A esté probado e2e — el checkout `/cc` lo reemplaza siendo
  más barato, nativo y sin dependencia externa. Madurar alertas.
  ✅ Pulido de UX en `/cc` (implementado 2026-07-03): la página ahora muestra
  SIEMPRE el atajo de misma red — "¿Ya tienes USDC en {red}? Envíalo directo a
  esta dirección" con la dirección del receptor resuelta públicamente y botón
  de copiar (no hay nada que cruzar si el pagador ya está en la red destino).
  ✅ Orígenes inbound ampliados (2026-07-03): además de Base Sepolia, el
  registro CCTP incluye **Ethereum Sepolia (dominio 0)** y **Avalanche Fuji
  (dominio 1)** — direcciones verificadas contra developers.circle.com (los
  messengers v2 son deterministas; USDC por chain verificado). Un origen
  inbound nuevo no exige gas nuevo del relayer (el mint siempre es en
  Arbitrum); como destinos OUTBOUND estas chains quedan ocultas
  automáticamente por el gas-gating fail-closed (I8) hasta que se decida
  soportarlas de ida. Al habilitar orígenes mainnet, mismo patrón, priorizando
  por finalidad del origen: Avalanche es Standard ~8s GRATIS como origen (§8).
- **Fase 2 — Inbound de una sola tx + fee inbound:** desplegar el MISMO
  `ParmeliaCrosschainRouter` de forma determinista en las 1-2 chains origen con
  más volumen (misma dirección por CREATE2). El checkout pasa de
  approve+`depositForBurn` (2 firmas) a `bridgeUSDC` (1 firma tras approve, o
  permit/EIP-3009 para una sola firma total), y habilita capturar fee inbound
  de forma explícita y atómica (I2 simétrico). Solo si el volumen inbound lo
  justifica.
- **Fase 3 — Rescate de depósitos mal dirigidos (#50):** watcher sobre redes
  comunes (Base/OP/Polygon) buscando USDC en direcciones de usuarios → notificar
  + recuperar reproduciendo la cuenta por CREATE2 (misma factory/impl/initData →
  misma dirección; la passkey del usuario la controla allí) + bridge vía CCTP.
  Es soporte/seguro, no producto; requiere la infra de Fase 2 en esa red. Hasta
  entonces el caso queda mitigado por la advertencia permanente en las UIs de
  recibir ("solo USDC en Arbitrum") y es recuperable manualmente.

### 12.1 Criterio para agregar una chain destino
Checklist completo o no se agrega: (a) dominio CCTP v2 existente; (b) entrada en
`CCTP_CHAINS` + `CHAIN_BY_ID` del server; (c) RPC dedicado en `CCTP_RPC_URLS`;
(d) gas del relayer fondeado + alerta configurada; (e) explorer para los links
de la UI; (f) demanda real que justifique la obligación operativa permanente.

---

## 13. Preguntas cerradas (no re-litigar)

| Pregunta recurrente | Respuesta cerrada | Razón corta |
|---|---|---|
| ¿Across para inbound? | No. Se retira entero en Fase 1. | Fee apilada + API key + su ventaja (2s vs 20s) es inmaterial en checkout. |
| ¿LI.FI / agregadores? | No, salvo excepción documentada para no-USDC/no-CCTP futuro. | 0.25% ≈ 20x el costo de CCTP Fast. |
| ¿Forwarding Service? | No al ticket actual. | $0.20 fijo = 2% de un pago de $10. |
| ¿`destinationCaller` restringido? | No. `bytes32(0)` permanente. | Sostiene I1 (ningún burn se pierde) y el manual_complete. |
| ¿Relayer gestionado / red de relayers? | No. El propio es best-effort, no de confianza. | I1 hace que su caída sea demora, no pérdida. |
| ¿Fast o Standard por default? | Fast; Standard como "Económico" explícito. | 1.3 bps ≈ $0.0013 por $10; nunca degradar en silencio (I9). |
| ¿Fee en inbound v1? | 0. | Sin contrato en origen no hay forma atómica de cobrarla (I2). Llega con Fase 2. |
| ¿Tokens no-USDC? | No-objetivo. Ruta futura: swap interno → USDC → cross-chain. | Un solo rail canónico; sin matriz de wrappers. |
| ¿Hooks de CCTP v2 (auto-forward a Earn, etc.)? | No por ahora. | Los patrones con `destinationCaller`/hooks comprometen I1; reevaluar solo con un patrón que preserve el permissionless. |
| ¿Estado `refunded`? | No existe. | Un burn siempre se completa hacia adelante; no hay devoluciones en burn/mint. |

---

## 14. Referencias y changelog

Referencias primarias (verificadas jun-2026): Circle CCTP fees
(developers.circle.com/cctp/concepts/fees — Standard gratis, Fast 0-14 bps),
Forwarding Service (…/concepts/forwarding-service — $0.20 + gas), TokenMessenger
`depositForBurn` (github.com/circlefin/evm-cctp-contracts), mecánica v2
(receiveMessage permissionless, maxFee/minFinalityThreshold), Across API
(docs.across.to/api-reference), LI.FI fees (docs.li.fi/faqs/fees-monetization).

Changelog: **v1.1** decisiones base (maxFee sin fallback, destinationCaller=0).
**v1.2** Flow B implementado + probado e2e; Flow A implementado. **v1.3**
pantalla Recibir + hardening operativo (kill switch, flags, gas-gating).
**v1.4** endurecimiento (registro antes de firmar, fail-closed, dedupe +
validación de mensaje, rotación/TTL/intentos, estados monótonos, migración
0006). **v2.0 (este documento)** cierre del debate de arquitectura: invariantes
explícitos (§4), tabla de modos de fallo (§7), capa de operación (§10),
procedimiento de decisión (§2.1), preguntas cerradas (§13) y roadmap por fases
con el retiro de Across y el camino a inbound de una tx (§12).

# Plan de implementación — Checkout universal y aceptación USDC en tres redes

**Fecha:** 25 de agosto de 2026<br>
**Estado:** Fase 1 cerrada en testnet; corte App/Payments histórico promovido pero Fase 2.1 reabierta por auditoría<br>
**Primera salida objetivo:** Arbitrum como red hogar; cobros desde Arbitrum, Base y Avalanche<br>
**Activo inicial:** USDC nativo

Este documento convierte la visión de intents, routing y settlement en un primer
corte de producto acotado. La Fase 1 de contratos/testnets ya tiene evidencia y
la separación App/Payments de la Fase 2 ya existe en el código y las migraciones.
La revisión posterior detectó gaps de configuración, recuperación, concurrencia,
contabilidad y cutover; ya se incorporaron al alcance y se corrigieron localmente
en 3A–3C. La promoción sigue bloqueada hasta completar los gates remotos. Este plan no
propone transformar toda la aplicación en una wallet multichain antes de mainnet.

La Fase 2 sí fue provisionada y desplegada el 25-08-2026, pero el Worker remoto
no contiene el hardening posterior, falta `0006` y el checksum histórico sólo
cubría IDs. El siguiente rollout no reetiqueta esa evidencia: conserva la D1 y
repite freeze/import/verify hacia un target nuevo mediante manifest v4/checksum
semántico v2. La realidad del código y de los preflights prevalece sobre cualquier
casilla histórica de este documento.

## 0. Decisión ejecutiva

La primera mejora debe ser:

> **Un mismo link de pago que se pueda pagar con saldo GatoPago o con USDC desde
> una wallet externa en Arbitrum, Base o Avalanche, sin exigir una cuenta
> GatoPago al pagador externo. El comercio recibe en Arbitrum.**

La promesa pública correcta sería:

> **Acepta USDC desde Arbitrum, Base y Avalanche. Recibe en Arbitrum.**

No se debe prometer todavía “cualquier activo”, “cualquier chain”, un saldo
universal ni una wallet plenamente operativa en tres redes.

### Topología de la primera versión

| Origen del pago | Ejecución | Liquidación del comercio |
|---|---|---|
| Saldo GatoPago en Arbitrum | UserOperation + `ParmeliaPaymentRouterV2` + passkey | USDC en Arbitrum |
| Wallet externa en Arbitrum | `ParmeliaPaymentRouterV2` | USDC en Arbitrum |
| Wallet externa en Base | `ParmeliaCctpPaymentRouter` + CCTP v2 | USDC en Arbitrum |
| Wallet externa en Avalanche | `ParmeliaCctpPaymentRouter` + CCTP v2 | USDC en Arbitrum |

Arbitrum continúa siendo la red de cuenta, saldo, swaps, Earn, paymaster e
historial principal. Base y Avalanche entran primero como **redes de origen de
pagos**, no como tres copias completas de la aplicación.

Esta separación reduce mucho el alcance: para aceptar un pago externo no hace
falta desplegar cuentas, paymasters, indexación de todos los balances ni recovery
en Base/Avalanche. Solo hacen falta el router de cobro, USDC nativo, CCTP y una
reconciliación multired acotada.

### Por qué CCTP directo y no Circle Gateway en este primer corte

Circle Gateway sí merece seguimiento: mantiene USDC depositado en contratos no
custodiales como un saldo unificado entre redes y, una vez establecida/finalizada
esa posición, permite moverlo en menos de 500 ms. Arbitrum, Base y Avalanche
están soportadas. Eso lo convierte en un candidato real para treasury, usuarios
recurrentes y una futura experiencia de saldo preposicionado.

No sustituye bien, sin embargo, al checkout puntual de una wallet externa:

| Situación | Rail recomendado | Motivo |
|---|---|---|
| Un pagador llega por primera vez con USDC en su wallet | CCTP directo | Firma y mueve los fondos que ya tiene; no necesita abrir antes una posición Gateway. |
| Un usuario o negocio mantiene fondos depositados para reutilizarlos | Evaluar Gateway | La espera de finalidad se paga al depositar y luego el saldo queda disponible entre redes. |

Gateway exige usar un método de depósito —una transferencia ERC-20 plana al
contrato no acredita el saldo— y espera finalidad antes de habilitarlo. Circle
publica aproximadamente 13–19 minutos para depósitos de Arbitrum/Base y unos 8
segundos para Avalanche. Añadir ese paso al primer pago empeoraría la conversión
frente a CCTP Fast en Base o CCTP Standard en Avalanche.

Hay además una incompatibilidad de seguridad importante con la cuenta actual:
Gateway requiere que una smart contract account autorice a un EOA para firmar
sus burn intents, y `addDelegate` otorga a ese delegado control completo sobre el
saldo Gateway del token. No es equivalente a una capacidad acotada por merchant,
monto y expiración. GatoPago no debe introducir esa delegación amplia en nombre
de la abstracción de chain.

**Decisión:** Universal Checkout v1 usa CCTP directo. Gateway queda como spike
posterior y solo avanza si (a) existe capital preposicionado recurrente, (b) el
beneficio de latencia/costo es medible y (c) existe un modelo de autorización
compatible con las políticas limitadas de GatoPago.

## 1. Hechos de partida y estado que condicionan el plan

1. El runtime sigue siendo mono-chain: `CHAIN_KEY` y `VITE_CHAIN_KEY` eligen una
   única red activa. `getPublicClient`, cuentas, balance, paymaster, indexer y Home
   dependen de esa red.
2. `PayPage.tsx` es público para leer el link, pero el botón de pago exige login y
   termina en `/pay/prepare`; la wallet externa no está integrada en el checkout.
3. Flow B canónico ya usa endpoints públicos de quote/attempt ligados al payer;
   `GET /v1/payment_intents/:id/onchain` queda solo como compatibilidad N-1.
4. El inbound CCTP de cobro ya está ligado a `PaymentIntent`/`PaymentAttempt` y
   vive en Payments. `/cc/:recipient` no es la nueva superficie de checkout.
5. `payment_intents`, quotes y attempts ya conservan settlement, source/destination
   tx y snapshot económico; no dependen de un único `tx_hash` ambiguo.
6. Payments posee la máquina CCTP de attempts de checkout; App conserva la
   máquina CCTP personal. Ninguna operación se copia, reconcilia o ejecuta desde
   los dos dominios.
7. Las quotes CCTP consultan la fee viva de Circle con timeout, caducidad y
   fail-closed; no existe un fallback hardcodeado oculto.
8. El registry y el router respetan capabilities: Base permite Fast/Standard y
   Fuji únicamente Standard.
9. Los contratos tienen una base saludable: `pnpm test:fork` pasa **197 tests**
   sin fallos ni omisiones, incluidas seis pruebas fork vivas en Arbitrum
   Sepolia, Base Sepolia y Fuji. Esto verifica las integraciones de testnet, no
   equivale a readiness de mainnet ni sustituye una auditoría externa.
10. `DeploymentRoles` trata Arbitrum, Base y Avalanche mainnet como entornos de
    roles segregados; Base/Avalanche aún no activan cuenta/paymaster.
11. Paymaster y smart account permanecen solo en la home chain. Antes de llevarlos
    a otra red se necesitan parámetros de stake/deposit/cap propios de su moneda.
12. Gateway resuelve saldo USDC unificado, no el onboarding instantáneo de fondos
    que todavía están en una wallet externa; su integración con smart accounts
    depende hoy de un EOA delegado con allowance completo sobre ese saldo.

## 2. Invariantes de producto y seguridad

Todo PR de esta iniciativa debe preservar estos invariantes:

| ID | Invariante |
|---|---|
| U1 | `PaymentIntent.amount` significa el monto neto mínimo que espera el comercio; las fees del pagador se calculan aparte. |
| U2 | El comercio siempre liquida USDC nativo en la red hogar configurada; en v1 es Arbitrum. |
| U3 | Una wallet externa puede pagar sin Firebase ni cuenta GatoPago. El login aparece solo si elige saldo GatoPago. |
| U4 | Toda tentativa existe en D1 antes de devolver una autorización o calldata que pueda mover fondos. |
| U5 | Ninguna ruta se ofrece si chain, contratos, fee viva, RPC o gas de relayer no pueden verificarse. |
| U6 | El backend y el relayer no pueden cambiar payer, merchant, monto, chain, deadline ni fee después de la firma. |
| U7 | Un burn CCTP siempre conserva recuperación permissionless: `destinationCaller = bytes32(0)` y sin hooks en v1. |
| U8 | La UI no muestra un saldo agregado ficticio. Home sigue mostrando el saldo real de Arbitrum. |
| U9 | El router no conserva fondos entre transacciones y las transferencias son atómicas. |
| U10 | El estado de pago sale de evidencia on-chain reconciliada, no de lo que diga el navegador. |
| U11 | Un refresh o cierre del navegador después del broadcast no puede dejar el pago sin atribuir. |
| U12 | No se afirma “exactamente una vez entre chains”: se previene lo prevenible y un segundo settlement se detecta como sobrepago. |
| U13 | Un link de monto abierto fija el monto antes de emitir autorización y no permite que dos pagadores congelen valores distintos. |
| U14 | Cada tabla mutable tiene un único dominio propietario; ningún Worker escribe directamente en la base del otro. |
| U15 | Checkout y `/v1` continúan operativos aunque el Worker de la app no esté disponible. |
| U16 | Ninguna transición depende de una transacción distribuida: commands, jobs y callbacks son versionados e idempotentes. |
| U17 | La política comercial por defecto es `free-default`: ninguna variable BPS aislada puede activar un cobro. |
| U18 | Quote y attempt congelan policy/version/rule, fee, bearer, recipient y cap; un cambio posterior nunca modifica una autorización firmada. |
| U19 | Un cambio o fallback de paymaster ocurre antes de la firma, reconstruye/reestima la UserOperation y conserva proveedor + dirección exacta para drenaje. |

U12 merece atención: tres contratos en tres redes no comparten storage. Ningún
`mapping(invoiceId => paid)` puede impedir por sí solo que dos autorizaciones ya
emitidas se ejecuten simultáneamente en Base y Avalanche. La primera versión
reduce ese riesgo con un intento activo, payer ligado, autorización corta y
reconciliación CAS; si aun así llegan dos settlements, el segundo se registra y
entra al flujo de sobrepago/refund. Ocultarlo sería una garantía falsa.

## 3. Modelo del intent y la ruta

```text
PaymentIntent
  "el comercio recibe al menos 100 USDC en Arbitrum"
                         │
                         ▼
                   PaymentAttempt
       payer + source chain + quote + deadline
                         │
             ┌───────────┼───────────┐
             │           │           │
       GatoPago/Arb   wallet/Arb   wallet/Base o Avalanche
             │           │           │
         UserOp      local router    CCTP payment router
             │           │           │
         local router    │           │
             │           │           │
             └───────────┴──────┬────┘
                                ▼
                    settlement USDC / Arbitrum
                                │
                     receipt + event + webhook
```

Un `PaymentIntent` expresa el resultado. Un `PaymentAttempt` congela una quote y
una ruta concreta. CCTP, router local y UserOperation son steps de ejecución, no
productos separados para el usuario.

## 4. Cambios de contratos

### 4.1 `ParmeliaPaymentRouterV2` — pago externo local

Reemplazar el router actual antes de mainnet; no hacerlo upgradeable. El contrato
es pequeño y versionarlo/redeployarlo reduce el riesgo de proxy admin.

Cambios recomendados:

- USDC inmutable para el lanzamiento, en lugar de una whitelist genérica de
  tokens. Los activos arbitrarios quedan fuera de alcance.
- Autorización EIP-712 tipada y versionada, ligada a:
  `intentId`, `attemptId`, `payer`, `merchant`, `settlementAmount`,
  `platformFee`, `validAfter`, `validUntil` y `metadataHash`.
- `payer` siempre concreto. Una autorización vista por un tercero no puede ser
  usada para pagar/griefear desde otra cuenta.
- `usedAttempt[attemptId]` y `paidIntent[intentId]` en la red local.
- Semántica neta: transfiere `settlementAmount` al merchant y `platformFee` a
  treasury. La fee ya no se descuenta del monto prometido al comercio.
- Eliminar `bytes metadata` libre del calldata/evento. Hoy no está ligado por la
  firma y puede ser alterado o inflado. Emitir `metadataHash`; el JSON vive en D1.
- `pauseGuardian` separado: owner frío/multisig puede pausar y despausar; una
  clave operativa dedicada solo puede pausar.
- Mantener `Ownable2Step`, `Pausable`, `ReentrancyGuard`, `SafeERC20`, cap duro
  de fee y patrón checks-effects-interactions.
- Conservar una variante `payWithPermit` solo si un fork test demuestra que el
  USDC real de esa red soporta el esquema esperado. Si no, fallback explícito
  `approve` + `pay`; nunca anunciar una llamada que el token/router no soporta.

### 4.2 `ParmeliaCctpPaymentRouter` — pago externo Base/Avalanche → Arbitrum

Nuevo contrato en cada red origen. Debe ser USDC-only, no upgradeable y con
destino hogar inmutable.

La autorización EIP-712 debe ligar como mínimo:

```text
intentId
attemptId
payer
merchant (mintRecipient)
settlementChainId
destinationDomain
settlementAmount       -- mínimo que espera el comercio
grossPayerAmount       -- máximo total que sale del pagador
platformFee
maxCctpFee
minFinalityThreshold
validAfter / validUntil
```

Reglas on-chain:

- Verificar `msg.sender == payer`, firma, ventana temporal y replay.
- Marcar attempt/intent antes de las interacciones; un revert revierte también
  esas marcas.
- Cobrar la fee de plataforma solo si todo el burn ocurre atómicamente. En el
  piloto, configurar esta fee en **0** aunque el contrato cubra el caso futuro.
- Quemar `grossPayerAmount - platformFee` y exigir:
  `burnAmount - maxCctpFee >= settlementAmount`. Así, incluso en el peor fee
  autorizado, el comercio recibe al menos el monto del intent.
- Fijar `destinationDomain = 3` (Arbitrum) en v1 y rechazar cualquier otro.
- Admitir solo finality `1000` o `2000`; Base puede usar Fast/Standard y
  Avalanche solo Standard según la matriz de capacidades del backend.
- Mantener `destinationCaller = bytes32(0)`. No introducir Hooks ni un executor
  de destino en esta primera versión.
- Emitir un evento compacto con `intentId`, `attemptId`, payer, merchant, monto,
  fee y parámetros CCTP. Ese evento permite recuperar la atribución si el
  navegador cierra después del broadcast y antes de registrar el tx hash.
- Añadir `payWithPermit` únicamente tras verificar el USDC real con fork tests.

Con CCTP directo el output puede ser ligeramente superior al mínimo si la fee
real es menor que `maxCctpFee`. El backend guarda el monto realmente minteado y
emite `payment.overpaid` si corresponde. Conseguir “exactamente X” requeriría un
settlement executor en destino; no vale la superficie extra en v1.

### 4.3 Endurecer `ParmeliaCrosschainRouter` actual

Este contrato sigue sirviendo al envío outbound de usuarios GatoPago y no debe
mezclarse con el nuevo router de cobros.

- Añadir `usedOpId` para que un mismo identificador no produzca dos burns.
- Añadir allowlist de dominios y validar finality `1000/2000`.
- Mantener USDC/messenger inmutables, fee cap, cero custodia y caller de destino
  permissionless.
- Actualizar pruebas de replay, dominio, finality, redondeo y conservación.

### 4.4 Cuenta, factory y recovery

No añadir routing, permisos comerciales ni lógica de intents a
`AccountWebAuthnV2`. La cuenta debe seguir siendo una primitiva de autorización.

Para esta primera salida:

- La cuenta y el paymaster continúan activos solo en Arbitrum.
- Probar ahora la infraestructura de cuenta en Arbitrum Sepolia, Base Sepolia y
  Fuji para confirmar dirección determinista, compatibilidad del EntryPoint y
  costo de P256; no exponer todavía esos saldos en producto.
- Conservar la factory permissionless e idempotente. El backend actual despliega
  la cuenta con una transacción normal a `createAccount`, por lo que exigir
  `SenderCreator` rompería ese flujo. Añadir un test que demuestre que un tercero
  solo puede desplegar la misma cuenta ya inicializada y no controlarla.
- Resolver el hallazgo M-1 principalmente en operación: guardian de recovery en
  Safe/MPC/HSM con umbral y separado del Worker caliente; permitir opt-out/rotación
  al usuario. Una sola EOA de backend para todas las cuentas no es aceptable en
  mainnet.
- Si se decide un `AccountWebAuthnV3` antes de auditoría externa, limitarlo a una
  mejora pequeña: expiración de propuestas de recovery y eventos con hash de la
  propuesta. No adoptar ERC-7579/7715 ni sesiones delegadas en este ciclo.

### 4.5 Paymaster y scripts de deploy

- Generalizar `DeploymentRoles.isMainnet` para `42161`, `8453` y `43114`; añadir
  los tres testnets como redes donde la reutilización deliberada de roles sí se
  permite.
- Hacer configurables por chain el stake, depósito, `unstakeDelay` y
  `maxSponsoredGasCost`; no usar `0.005 ether` como política universal.
- En fase 1, desplegar/fondear paymaster solo en Arbitrum. Base/Avalanche son
  pagos de wallet externa y el pagador cubre su gas.
- Generar un manifest JSON por despliegue: chain id, address, constructor args,
  bytecode hash, tx hash, owner, treasury, signer y estado de aceptación del
  `Ownable2Step`.
- Preflight obligatorio: codehash de EntryPoint v0.9, USDC y CCTP; presencia del
  CREATE2 deployer; addresses predichas; roles distintos en mainnet.
- No asumir que “mismo salt” basta. La igualdad de dirección exige mismo
  deployer CREATE2, salt, bytecode y constructor args.

## 5. Cambios de backend

### 5.1 Frontera multichain

No reemplazar `CHAIN_KEY` en toda la aplicación. Mantenerlo como **home chain**
para cuentas, Home, swaps, Earn, UserOperations e indexación de usuarios.

Crear una frontera separada para pagos externos:

- Ampliar `shared/networks.ts` con `base`, `avalanche-fuji` y `avalanche`, además
  de los entries existentes.
- Añadir capacidades explícitas por red:
  `isHomeChain`, `paymentSource`, `cctpStandard`, `cctpFast`,
  `localPaymentRouter`, `cctpPaymentRouter`, `permitMode`.
- Mapear las seis redes en `server/src/chain.ts` usando las definiciones de viem.
- Añadir `getPaymentPublicClient(chainId)` y
  `getPaymentWalletClient(chainId)` sobre RPCs separados por chain. Los clientes
  existentes sin argumento continúan apuntando a la red hogar.
- Reutilizar el control plane/fallback RPC actual; en producción todas las URLs
  externas deben ser HTTPS y la chain id leída por RPC debe coincidir con la
  configuración.
- Mantener un único relayer de mint en Arbitrum para los cobros inbound. Base y
  Avalanche no necesitan una clave de relayer para iniciar el pago.

Configuración sugerida, compatible con una migración gradual:

```text
CHAIN_KEY=arbitrum-sepolia                 # sigue siendo la home chain
PAYMENT_SOURCE_CHAIN_IDS=421614,84532,43113
CCTP_RPC_URLS={...}                        # ya existe; validar las 3 rutas
PAYMENT_SOURCE_DISABLED_CHAIN_IDS=
```

No guardar direcciones de contratos o USDC solo en env: deben vivir en el
registry tipado y validarse contra codehash/config al iniciar.

### 5.2 Datos — migración propuesta de payment attempts

Crear el schema en la nueva base propietaria mediante
`payments-worker/migrations/0001_payments_schema.sql`. La app conserva su
historial `0001`–`0032`; si necesita adaptar `pending_payments` o retirar una FK
cross-domain, usa su siguiente número libre (`0033`) sin administrar tablas de
Payments. El procedimiento de copy/cutover se define en §5.6.

Extender `merchants` para que Payments no dependa de un join contra `users`:

```text
owner_uid                    -- referencia lógica, sin FK cross-database
settlement_wallet_address
settlement_chain_id
account_version              -- rechaza snapshots viejos de App
updated_at
```

La wallet se copia desde el perfil vigente durante el backfill. Todo cambio
posterior llega mediante el command versionado App → Payments; una quote siempre
congela la wallet efectiva dentro de `route_json`.

Extender `payment_intents`:

```text
amount_mode: fixed | payer_defined
settlement_chain_id
settlement_token
settlement_amount_raw
amount_received_raw
settlement_tx_hash
status: awaiting_payment | processing | paid | requires_review | expired | canceled
```

Crear `payment_attempts`:

```text
attempt_id (PK)
intent_id (FK)
method: gatopago_account | external_local | external_cctp
payer_address
source_chain_id
destination_chain_id
token
settlement_amount_raw
gross_payer_amount_raw
platform_fee_raw
protocol_fee_max_raw
protocol_fee_actual_raw
finality_mode
route_json                 -- snapshot versionado de la quote
authorization_hash
authorization_expires_at
source_tx_hash
destination_tx_hash
status
failure_code / failure_detail redacted
created_at / updated_at / completed_at
```

Índices mínimos:

- único por `source_tx_hash` cuando no sea null;
- `intent_id, created_at`;
- `status, updated_at` para reconciliación;
- `authorization_hash` único;
- un solo intento **activo** por intent mediante índice parcial. El índice evita
  nuevas quotes concurrentes en D1, pero no se presenta como lock cross-chain.

La tabla `crosschain_operations` de `PAYMENTS_DB` incluye un
`payment_attempt_id` único y modela únicamente el CCTP de checkout;
`payment_attempts` es su vista de orquestación común. Las operaciones CCTP
personales y su tabla histórica permanecen en App y no se copian como intents ni
como filas query-only. En Payments, `payer_uid` es opcional: un checkout externo
puede no tener usuario GatoPago y conserva `payer_address`/`owner_uid` como
identidad de atribución.

Migración de links:

- Todo link nuevo crea `PaymentIntent` en la misma transacción D1.
- Un link de monto abierto usa `amount_mode=payer_defined`. Las quotes son
  provisionales y el monto queda bloqueado atómicamente al crear el primer
  attempt autorizable; si ese attempt expira sin broadcast, puede liberarse.
- Links pending antiguos se elevan de forma idempotente al abrirlos; links paid
  antiguos quedan como historial.
- No borrar datos de testnet automáticamente. Cualquier reset se decide aparte y
  con backup.

### 5.3 Servicios

Mover desde el actual `server/src/services/storage.ts` hacia repositorios propios
de `payments-worker/` y añadir:

| Servicio | Responsabilidad |
|---|---|
| `intentEngine.ts` | Valida intent, políticas y elige `gatopago`, `local` o `cctp`. |
| `paymentAttempts.ts` | Persistencia y CAS de intentos; una frontera transaccional. |
| `cctpFees.ts` | Consulta `/v2/burn/USDC/fees`, cache corta, timeout y fail-closed. |
| `paymentAuthorization.ts` | Construye y firma EIP-712 exactamente como los routers. |
| `paymentReconciler.ts` | Observa routers por chain, valida receipts y liquida el intent. |
| `checkoutPresenter.ts` | Devuelve solo datos públicos y copy-neutral al cliente. |

El router debe simularse con `publicClient.simulateContract` antes de devolver la
transacción. La simulación reduce errores del usuario; el receipt y los eventos
siguen siendo la verdad final.

### 5.4 API pública del checkout

Mantener `/v1` para el comercio con su `sk_`. Añadir una superficie pública y
rate-limited basada en el UUID no adivinable del link:

```text
GET  /checkout/:linkId
POST /checkout/:linkId/quotes
POST /checkout/:linkId/attempts
POST /checkout/:linkId/attempts/:attemptId/register
GET  /checkout/:linkId/attempts/:attemptId
```

`GET /checkout/:linkId` devuelve comercio, monto neto, expiración y métodos
habilitados; nunca metadata privada, API keys ni configuración interna.

`POST .../quotes` recibe `sourceChainId`, payer y preferencia de velocidad. El
server decide la ruta y responde:

```json
{
  "route": "external_cctp",
  "source_chain_id": 84532,
  "settlement_chain_id": 421614,
  "merchant_receives_min": "100.00",
  "payer_spends_max": "100.02",
  "network_fee_max": "0.02",
  "mode": "fast",
  "expires_at": "..."
}
```

`POST .../attempts` persiste primero y luego devuelve autorización/tx. La
autorización dura 3–5 minutos y queda ligada al payer conectado.

Una cancelación merchant no puede fingir que revocó una firma ya emitida. Si hay
un attempt con autorización todavía válida o un tx en vuelo, `/cancel` responde
conflicto; se cancela después de expirar o se liquida si el pago aterriza.

El endpoint `/v1/payment_intents/:id/onchain` actual se depreca después de migrar
integradores; no se expone una `sk_` en el checkout.

### 5.5 Reconciliación y webhooks

- Registrar `payment.processing` cuando el router local fue incluido o el burn
  CCTP quedó validado.
- Marcar `paid` solo cuando el comercio tiene los fondos según la política:
  local = evento/finalidad de Arbitrum; CCTP = `MintAndWithdraw` verificado en
  Arbitrum.
- Reutilizar Iris, `validateCctpMessage`, retries, `manual_complete` y gas-gating.
- Parametrizar el watcher del router por chain y reutilizar el algoritmo de
  journal/checkpoints/reorg handling con tablas propias en `PAYMENTS_DB`; no leer
  ni escribir el journal de App ni crear un watcher ingenuo paralelo.
- El evento del router permite encontrar un attempt aunque el cliente no haya
  llamado `/register`.
- La transición `processing → paid` y el outbox de webhook ocurren en un batch
  D1 idempotente.
- Emitir `payment.overpaid` si un segundo settlement o un output superior al
  esperado aparece. Nunca perder esa evidencia aunque el intent ya esté `paid`.
- Un attempt fallido no mata el intent: si no hubo movimiento y el link no
  expiró, vuelve a permitir una nueva quote.

### 5.6 Topología de despliegue, datos y escala

La Fase 2 adopta **dos Workers públicos, dos D1 físicos y dos colas**. El
dashboard es un cliente del dominio de pagos; no tiene ni necesita un “Worker
del dashboard”. Tampoco se crea ahora un tercer Worker de settlement.

| Opción evaluada | Decisión | Motivo |
|---|---|---|
| Un Worker + un D1 | Rechazada | Mezcla secretos, releases, SLAs y dos dominios con ritmos distintos. |
| Dos Workers + un D1 compartido | Rechazada | Aísla código, pero conserva contención, schema acoplado y permisos de escritura cruzados. |
| Dos Workers + dos D1 | **Elegida** | Aísla fallos y escrituras sin introducir una cadena de microservicios. |
| Tres Workers desde ahora | Diferida | El consumidor Queue puede vivir en Payments; extraerlo hoy no aumenta throughput de D1 y sí añade versionado/deploy operacional. |

```text
App React ───────────────► App API (`server`) ───► GATOPAGO_DB
       │                         │                     │
       │                         └──── app-jobs ───────┘
       │
       └─ links/pagos ──► gatopago-payments-api ─► PAYMENTS_DB
                                  ▲       │              │
Dashboard React ──────────────────┤       └─ payment-jobs┘
Checkout público ─────────────────┘

Compatibilidad temporal:
App API (`server`) ── Service Binding RPC ──► gatopago-payments-api
```

La dependencia interna es **unidireccional**: app → payments. Payments nunca
llama sincrónicamente a app para crear una quote, aceptar un pago o reconciliarlo.
Así, una incidencia de Home, passkeys o indexación personal no tira el checkout
ni la API del comercio. El Service Binding se usa durante la migración para
conservar rutas existentes y para commands internos acotados; los clientes nuevos
hablan directamente con el Worker propietario.

| Deployable | Posee | Superficies principales | Secretos/capabilities |
|---|---|---|---|
| App API (código y deploy remoto `server`) | identidad de producto, smart accounts, UserOperations, Home, ledger, swaps, Earn, contactos, card e indexación de wallets | `/auth`, `/user`, `/account`, `/home`, `/pay` de ejecución, `/swap`, `/earn`, `/contacts`, `/card` | email, recovery, paymaster, bundler/relayer ERC-4337 y RPCs de cuenta |
| `gatopago-payments-api` (nuevo `payments-worker/`) | links, merchants, intents, quotes, attempts, routing, CCTP de pagos, settlement, eventos y webhooks | `/links`, `/checkout`, `/v1`, `/merchant` y endpoints de ingestión de routers | signer de autorizaciones, CCTP/relayer de cobros, webhook encryption y RPCs de pago por chain |

Ambos Workers verifican los Firebase ID tokens localmente contra JWKS; Payments
no delega autenticación de dashboard a App. Las API keys `sk_` existen solo en
Payments. App usa el RPC interno únicamente para commands con identidad y
versión explícitas, por ejemplo provisionar/actualizar la wallet de settlement o
conservar temporalmente una ruta antigua.

El primer cutover actualiza App **in-place** bajo el nombre remoto `server` y
conserva `parmelia-scheduled-jobs`. Renombrar esos recursos no forma parte de la
frontera de dominio y se difiere para evitar migrar a la vez secretos, Durable
Objects, URLs públicas y estado de Queue.

`/crosschain` se separa por intención, no por archivo heredado. Una transferencia
CCTP personal iniciada por la cuenta —incluidos su estado, reconciliación y
relayer— permanece en App. Solo el CCTP que ejecuta un `PaymentIntent` de
checkout/comercio pertenece a Payments. Son dos casos de uso y dos estados
propietarios; no se copian operaciones personales a `PAYMENTS_DB` ni se ejecuta
una misma operación desde ambos Workers.

#### Propiedad de datos

La opción “dos Workers, un solo D1” queda descartada. Cloudflare escala las
invocaciones de Worker, pero cada D1 individual procesa queries de forma
single-threaded. Compartir la base conservaría el mismo cuello de botella de
escritura y permitiría que cualquier cambio de app rompiera pagos.

- `GATOPAGO_DB` permanece con la app: `users`, auth/WebAuthn, passkeys,
  operaciones de cuenta/UserOp, ledger, balances/read models, swaps, Earn,
  contactos, card y estado del indexer de wallets.
- `PAYMENTS_DB` nace en Fase 2: `payment_links`, `merchants`, `api_keys`,
  `payment_intents`, `payment_attempts`, `crosschain_operations` de checkout,
  settlement checkpoints, `payment_fee_ledger`, `webhook_endpoints`, `events`,
  `webhook_deliveries`, rate limits y outboxes de pago.
- `owner_uid`, `payer_uid` o `payment_attempt_id` son referencias lógicas entre
  dominios, nunca foreign keys cross-database. El comercio guarda en Payments
  su wallet de settlement versionada; no hace un join en vivo contra `users`.
- Cuando App crea o cambia una cuenta, envía a Payments un command idempotente
  con `accountVersion`; Payments rechaza updates viejos y el checkout sigue
  leyendo su snapshot local.
- Links, intents, attempt, evento y webhook outbox sí viven juntos en
  `PAYMENTS_DB`, por lo que cada transición económica y su evento se confirman
  en un único `D1.batch()` atómico.
- Rutas y handlers no reciben un binding D1 genérico. Acceden mediante
  repositorios del dominio; esto impide imports accidentales y deja una costura
  para particionar Payments por comercio si la carga medida lo exige.

La base nueva tiene su propio historial desde
`payments-worker/migrations/0001_payments_schema.sql`; `0002` añade snapshots y
ledger económico y `0003` indexa los hot paths de checkout, reconciliación,
health, retención y cursores con un gate local de planes de consulta. En App,
`0033` adapta referencias locales como
`pending_payments.payment_attempt_id` y `0034` registra sponsorship; ninguna
crea ni administra tablas de Payments.
El cutover aplica primero `0001` + `0002` + `0003` mediante Wrangler para conservar su
historial canónico y después carga un artefacto data-only que nunca toca
`d1_migrations`. El script copia IDs intactos, calcula conteos/checksums, prueba
la importación sobre un schema recién migrado, rechaza replay/D1 no vacía y
verifica backup/restore; las tablas legadas no se borran en la misma entrega y
quedan read-only hasta cerrar el soak test.

#### Consistencia sin transacciones distribuidas

El pago con saldo GatoPago usa también el router local para que las tres rutas
produzcan evidencia uniforme:

```text
1. payments: crea y reserva PaymentAttempt
2. payments: emite plan/autorización versionada y corta
3. app: prepara/firma/transmite UserOperation que llama al router local
4. payments: observa InvoicePaid y liquida intent + outbox atómicamente
5. app: indexa la transferencia en el ledger de usuario de forma idempotente
```

Si cualquier paso se repite, `attemptId`, `authorizationHash`, tx hash y CAS
producen el mismo resultado. La evidencia on-chain reconcilia estados dudosos;
no se intenta mantener una transacción abierta entre Workers o entre D1.

Los contratos RPC y mensajes de Queue viven como schemas TypeScript puros en
`shared/`, incluyen `contractVersion`/`messageVersion` y no importan storage ni
handlers. Cada cola tiene un único consumidor lógico en su Worker propietario,
IDs de dedupe, retries y DLQ. Queues entrega al menos una vez, por lo que toda
operación de dinero o webhook debe tolerar duplicados.

#### ¿Cuándo sí extraer un tercer Worker?

No se divide por cantidad de endpoints ni “por si acaso”. El candidato futuro
es `gatopago-settlement-consumer`, privado y queue-only. Se extrae sin cambiar la
API pública ni el schema de mensajes cuando se cumpla al menos uno de estos
gates medidos:

1. la clave de mint/relayer requiere una frontera de permisos o rotación
   independiente del Worker HTTP;
2. settlement necesita un ciclo de deploy/on-call distinto;
3. el lag de `payment-jobs` incumple su SLO después de ajustar concurrencia,
   batching y queries;
4. el bundle, CPU o memoria del dominio de pagos se acerca de forma sostenida a
   límites de plataforma.

Un `checkout-edge` separado solo se considera si tráfico público/abuso afecta el
SLO de `/v1` y `/merchant` aun con rate limits. Agregar tráfico normal no es un
motivo: Workers escala horizontalmente. Si el cuello es D1, añadir Workers no lo
arregla; se optimizan índices/queries y luego se particiona `PAYMENTS_DB` por
merchant mediante el repositorio, manteniendo los mismos dos Workers.

Los llamados síncronos se limitan a browser → Worker o app → payments: nunca una
cadena de microservicios. Los RPC internos validan identidad/claims de forma
explícita porque el contexto de Cloudflare Access no se propaga por Service
Bindings. Los cambios de contrato interno son aditivos: primero se despliega el
receptor compatible, después el caller y al final se retira la versión anterior.

## 6. Cambios de frontend

### 6.1 Checkout

`PayPage.tsx` ya es un hotspot. No añadirle toda la lógica multichain. Extraer un
módulo `features/checkout/` con:

```text
CheckoutPage
PaymentMethodPicker
GatoPagoBalanceMethod
ExternalWalletMethod
RouteQuote
PaymentReview
PaymentProgress
checkoutMachine.ts
```

Experiencia propuesta:

1. El pagador abre el link y ve comercio, referencia y monto.
2. Elige:
   - **Pagar con mi saldo GatoPago**;
   - **Pagar con otra wallet**.
3. Solo la primera opción pide login.
4. La wallet externa se conecta; el checkout detecta Arbitrum, Base o Avalanche
   y propone la ruta. La red aparece como detalle, no como la decisión principal.
5. Review único: “El comercio recibe”, “Tú pagas como máximo”, costo, tiempo
   estimado y red de origen.
6. Simulación, firma(s), progreso y receipt. El attempt se persiste en
   `sessionStorage` para reanudar tras refresh.

No usar “onchain”, “CCTP”, “bridge”, “domain” ni “mint” en el copy principal.
Esos términos pueden aparecer en “Detalles técnicos”.

### 6.2 Wallets externas

Mantener el adaptador del pagador externo aislado del sistema de passkeys de
GatoPago:

- viem para lecturas y writes;
- injected/EIP-1193 para extensiones o el navegador integrado de una wallet;
- transferencia directa/QR cuando la ruta lo permita.

GatoPago no usa un proveedor externo para crear, custodiar o controlar sus
wallets. El checkout no incorpora SDKs ni relays de conexión remota. Una wallet
externa sólo se usa cuando el navegador ya expone una interfaz EIP-1193; en los
demás casos se muestran instrucciones para abrir el link dentro de la propia
wallet. Esto no reemplaza Firebase, passkeys ni ERC-4337 de GatoPago.

Antes de escribir:

- validar chain id, payer, USDC y saldo de gas;
- simular el contrato;
- usar permit solo cuando la capability esté verificada;
- fallback visible a `approve` de monto exacto + `pay`, nunca allowance infinita;
- esperar receipt y comprobar `status`, pero dejar que el backend reconcilie.

### 6.3 Matriz UX por red

| Red detectada | Opción principal | Alternativa |
|---|---|---|
| Arbitrum | Pago local | — |
| Base | Fast | Standard económico, más lento |
| Avalanche | Standard | No mostrar Fast |
| Otra red | “Esta red todavía no está disponible” | Cambiar a una de las 3 |

### 6.4 Depósitos — siguiente reutilización inmediata

Después de cerrar el checkout, reutilizar el selector/routing en `/receive`:

- Renombrar la decisión principal a **Agregar dinero**.
- Métodos visibles solo si funcionan:
  - “Desde otra wallet” — Arbitrum/Base/Avalanche mediante la ruta interactiva;
  - “Desde un exchange” — inicialmente instrucción **Arbitrum directo**;
  - Binance/fiat únicamente cuando exista integración real.
- No decir que un retiro plano desde un exchange en Base/Avalanche se consolidará
  automáticamente: el exchange no puede firmar el call CCTP del usuario.
- Mostrar chain en la confirmación y el historial, no como una lista de productos.

## 7. Mapa de cambios por archivo

La organización exacta puede variar durante el refactor, pero estas son las
fronteras esperadas. Un PR que empiece a parametrizar servicios no relacionados
con checkout debe justificar por qué amplía el alcance.

| Capa | Archivo actual | Cambio esperado |
|---|---|---|
| Contratos | `contracts/src/ParmeliaPaymentRouter.sol` | Reemplazar por `ParmeliaPaymentRouterV2.sol`; mantener ABI anterior solo durante migración testnet. |
| Contratos | nuevo `contracts/src/ParmeliaCctpPaymentRouter.sol` | Router USDC Base/Avalanche → Arbitrum con EIP-712 y garantía de monto mínimo. |
| Contratos | `contracts/src/ParmeliaCrosschainRouter.sol` | Replay de `opId`, allowlist de dominio y finality. |
| Deploy | `contracts/script/DeploymentRoles.sol` | Política mainnet para 42161/8453/43114. |
| Deploy | `contracts/script/Deploy.s.sol` | Parámetros económicos por chain, manifests y nuevos routers. |
| Tests | `contracts/test/*.t.sol` | Unit, fuzz, invariants y tres suites fork; fixtures EIP-712 compartidos. |
| Registry | `shared/networks.ts` | Seis redes, capabilities de pago y routers por red. |
| App Worker | `server/src/index.ts`, `wrangler.jsonc` | Convertir el deployable actual en `gatopago-app-api`; conservar solo rutas/jobs/datos de app y añadir binding RPC unidireccional a Payments. |
| App Worker | `server/src/routes/{links,pay,crosschain}.routes.ts` | Separar ejecución de cuenta de orquestación; proxies de compatibilidad temporales sin acceso a `PAYMENTS_DB`. |
| Payments Worker | nuevo `payments-worker/` | Deployable `gatopago-payments-api` con Hono, health, auth JWKS/API keys, D1, Queue, DLQ y observabilidad propias. |
| Payments Worker | nuevo `payments-worker/src/chain.ts`, `services/clients.ts` | viem/RPCs de pago para Arbitrum/Base/Avalanche y sus testnets; la app conserva clients de home chain. |
| Payments Worker | nuevo `payments-worker/src/routes/{links,checkout,v1,merchant}.routes.ts` | Superficies del dominio de pago con middlewares/rate limits separados para público, Firebase y `sk_`. |
| Payments Worker | nuevos servicios de §5.3 | Policy/quote/auth/reconciliation y repositorios propietarios por responsabilidad. |
| Payments Worker | `services/feePolicy.ts`, `services/routerHealth.ts` | Policy versionada gratuita por defecto, caps por ruta y preflight on-chain antes de toda autorización pagada. |
| Payments Worker | relayer CCTP propio de checkout, router watcher y jobs de webhooks | Una sola máquina CCTP merchant por attempt, watcher por source chain y consumidor `payment-jobs`; el relayer personal no se mueve desde App. |
| Shared | `shared/` | Schemas versionados de RPC/jobs, errores, EIP-712 y registry; sin D1, env, secretos ni handlers. |
| Shared | `shared/fees.ts`, `shared/networks.ts` | Contratos económicos puros y ceilings inmutables observados por red/router. |
| Datos app | nueva `server/migrations/0033_*` solo si hace falta | Referencias lógicas a attempts y retiro de FKs cross-domain; no crea tablas Payments. |
| App sponsorship | `server/src/services/{sponsorship,sponsorshipHealth,userOp}.ts`, migración `0034` | Adaptadores Parmelia/ERC-7677/self-funded, fallback pre-firma y drenaje observable por provider/contrato. |
| Datos payments | `payments-worker/migrations/0001_payments_schema.sql`, `0002_fee_policy_and_ledger.sql`, `0003_query_scale.sql` | Links, intents, attempts, CCTP, settlement, snapshots, fee ledger, outboxes e índices de hot paths en `PAYMENTS_DB`. |
| Migración | `scripts/split-payments-d1.mjs` | Backup, IDs intactos, conteos/checksums, artefacto data-only sin `d1_migrations`, ensayo sobre schema migrado, guard anti-replay y rollback sin borrar tablas legadas. |
| Jobs | dos Queues/DLQ y schedulers separados | `app-jobs` y `payment-jobs`; un consumidor por cola, mensajes versionados e idempotentes. |
| API | `shared/errors.ts`, `docs/openapi.yaml`, `docs/api.md` | Errores estables, endpoints públicos, objetos y webhooks nuevos. |
| Frontends | `client/src/lib/api.ts`, `dashboard/src/*` | Bases API explícitas: app → App Worker; dashboard/checkout → Payments Worker; proxies solo durante transición. |
| Frontend | `client/src/pages/PayPage.tsx` | Reducirlo a composición; no añadir otra máquina de estados inline. |
| Frontend | nuevo `client/src/features/checkout/*` | Métodos, quote, review, progreso y resume. |
| Frontend | nuevo `client/src/lib/checkoutWallet.ts` | Provider/connectors limitados al checkout. |
| Frontend | `client/src/App.tsx`, `locales/{es,en}.json` | Provider de ruta y copy sin jerga on-chain. |
| E2E | `e2e/` | Links universales, wallets mock, tres chains y fallos recuperables. |
| Operación | `ARCHITECTURE.md`, `DEPLOY.md`, `SECURITY.md` | Topología, roles, manifests, flags, runbooks y gates reales. |

## 8. Orden de implementación

### Fase 0 — decisiones y fixtures (1–2 días)

- Aprobar los defaults de §11.
- Especificar ABI/EIP-712 con vectores de firma compartidos Solidity/TypeScript.
- Congelar manifest de addresses oficiales por testnet/mainnet.
- Añadir feature flags por source chain.

**Cierre:** spec revisada, fixtures que fallan ante cualquier diferencia de
encoding y ninguna promesa de UI por encima de las capabilities.

### Fase 1 — contratos y testnets (4–6 días)

**Estado al 24-08-2026: cerrada.** Los cuatro routers tienen manifests y smoke
tests reales; la evidencia congelada está en
[`testnet-smoke-evidence.json`](../../contracts/deployments/testnet-smoke-evidence.json).

- Implementar routers y hardenings de §4.
- Corregir `DeploymentRoles` y parametrizar deploy.
- Desplegar/redeployar solo en Arbitrum Sepolia, Base Sepolia y Fuji.
- Verificar source y codehash; guardar manifests.

**Cierre:** unit/fuzz/invariant verdes y una llamada real por cada router en su
testnet. Un deploy exitoso sin transacción real no cierra la fase.

### Fase 2 — separación de backend/datos + quote e intent engine (8–12 días)

**Estado al 25-08-2026: promovido en Cloudflare y Vercel.**
La entrega incluye dos Workers, dos schemas D1, dos colas por dominio,
Service Binding unidireccional App → Payments, contratos RPC/Queue N/N-1, copy y
restore verificables, intent/quote/attempt engine, settlement idempotente y
clientes App/Dashboard apuntando al propietario correcto.

1. Congelar schemas versionados de RPC/jobs y tests de contrato antes de mover
   handlers.
2. Crear `gatopago-payments-api`, `PAYMENTS_DB`, `payment-jobs` y sus health/
   observability gates; mantener `server/` como `gatopago-app-api`.
3. Crear el schema Payments, copiar datos locales con IDs intactos y probar
   backup/restore de **ambas** bases; no borrar las tablas legadas.
4. Mover links, merchants, `/v1`, checkout, intent/attempt, CCTP de pagos,
   settlement y webhooks al propietario Payments.
5. Separar `eventJobs`/scheduler/Queue por dominio y eliminar cualquier import o
   escritura D1 cruzada.
6. Añadir Service Binding app → payments para compatibilidad, con un solo hop,
   claims explícitos e interfaces aditivas.
7. Crear intent por todo link nuevo, compatibilidad para links anteriores, fee
   CCTP viva, attempts, EIP-712 y API pública.
8. Generalizar clients/watchers solo en la frontera de pagos y usar el router
   local también para el pago con saldo GatoPago.

**Cierre:** ambos Workers arrancan y pasan typecheck/tests por separado; checkout
y `/v1` funcionan con App Worker caído; app core funciona con Payments caído
salvo links/pagos; no hay acceso D1 cruzado; copy y restore cuadran conteos e
IDs; un mensaje Queue duplicado no duplica settlement/webhook; y pasan los tests
de idempotencia, expiry, tentativa activa, fee stale, chain disabled,
autorización manipulada y compatibilidad RPC N/N-1.

**Baseline local al entrar en Fase 3 (25-08-2026):** `pnpm verify` verde; App con 247
pruebas unitarias y 22 runtime; Payments con 30 unitarias y 9 runtime; 26 E2E de
navegador aprobadas y 10 omitidas; auditoría de dependencias sin vulnerabilidades
conocidas; 187 pruebas Foundry no-fork aprobadas y 4 pruebas fork omitidas por no
disponer de RPC; builds, límites de bundle, fronteras, OpenAPI y query plans
verdes; y backup/restore de App y del split App/Payments con integridad, foreign
keys, replay guard y checksum verificados. Esta evidencia demuestra que el
artefacto compila y pasa sus gates actuales, pero **no cierra Fase 2**: las suites
no detectaban los fallos de configuración, crash recovery y concurrencia listados
en Fase 3.

**Cutover remoto ejecutado el 25-08-2026:** la fuente contenía 4 merchants, 21
links y 21 intents. El snapshot se cifró y restauró antes de importar data-only
una vez sobre Payments; su checksum
`ffb10c840313390517ec88afe2590385f73bd4b7e500670340a9c979aac30bb9` coincide
con config y control D1. Las 7 operaciones CCTP personales permanecen en App y
0 se importaron. App terminó en boundary v2/modo `payments`, los outbox están
drenados, ambos Workers están sanos y los smokes directo/proxy pasan. El
preflight remoto concluye `fully promoted`; Vercel sigue fuera de este cierre
Cloudflare.

### Incremento 2.1 — economía y sponsorship extensibles, gratuitos por defecto

**Estado al 25-08-2026: backend y frontends promovidos.**
Este incremento no cambia la decisión comercial de no cobrar. El objetivo es
evitar que una excepción futura obligue a mezclar reglas comerciales con
contratos, alterar pagos en curso o redeployar smart accounts.

1. Payments resuelve una policy JSON versionada y acotable por merchant, modo,
   source chain, ruta y monto. Ausente = `free-default`; el máximo de plataforma
   es 100 bps y empates contradictorios fallan cerrados.
2. Cada quote y attempt persiste un snapshot económico inmutable. El
   `payment_fee_ledger` separa ingreso GatoPago de costo CCTP, y API, webhook y
   dashboard muestran quote vs. evidencia real.
3. `shared/networks.ts` declara el cap inmutable realmente desplegado. Antes de
   firmar una fee positiva, Payments lee code, cap, signer, treasury, USDC,
   pause state y configuración CCTP on-chain; cualquier drift degrada health y
   bloquea la autorización.
4. App selecciona `parmelia`, un servicio ERC-7677 o `self-funded` mediante un
   adaptador. Un fallback siempre ocurre antes de la firma y reconstruye/
   reestima el UserOp; provider y dirección exacta quedan en D1 y health para
   drenar una rotación de forma segura.
5. `GATOPAGO_FEES_ENABLED=false` sigue siendo el switch maestro de operaciones
   wallet/compatibilidad. Merchant checkout tiene una única autoridad económica
   en Payments, por lo que los dos Workers no pueden cobrar dos veces.

**Gate de entrada a Fase 3, reabierto por auditoría:** el corte Cloudflare y los
deployments Vercel existen, pero la verificación posterior demostró que el
dashboard está detrás de Vercel SSO, el checkout remoto sólo soporta provider
inyectado y un attempt público podía bloquearse con un hash inventado. El
candidato local corrige esos límites; no está promovido. El lanzamiento gratuito
usa los routers CCTP actuales con cap `0`.
Un redeploy preventivo con cap `100` sigue siendo una decisión separada de
negocio, no una condición para corregir el software.

<a id="fase-3-hardening"></a>

### Fase 3 — hardening de Payments + checkout público (8–12 días)

**Estado al 25-08-2026: componentes base promovidos; hardening posterior sólo local y evidencia transaccional completa aún pertenece a Fase 4.** Esta fase absorbe los
hallazgos de la auditoría posterior a Fase 2. Primero cierra seguridad económica,
recuperación y cutover; después amplía la UX pública. Ningún test verde anterior
permite omitir los gates de esta sección.

**Corte local actual:** los diez bloqueadores 3A están implementados y cubiertos
por sus gates; 3B usa `client/src/features/checkout/` para API, provider,
ejecución y resume. El checkout prioriza wallet externa, conserva saldo GatoPago
como opción, y el E2E prueba injected wallet, fallback EIP-2612 →
`approve + pay`, caída del registro y reanudación después de recargar. 3C pasó
la verificación integral y el ensayo local compuesto de cutover/rollback: modos
bootstrap/sync/freeze, compatibilidad N/N-1, base vacía, import único, checksum,
    outbox y restores independientes. La auditoría posterior reabrió 3C: falta
    repetir el gate integral, versionar, aplicar `0006` y promover. Que un
    deployment exista no prueba acceso anónimo ni universalidad del checkout.

#### 3A. Bloqueadores de backend y operación

1. **Contrato real de App Queue.** Hacer coincidir el nombre consumido por
   `eventJobs` con `parmelia-scheduled-jobs`, su binding productor y su consumer
   Wrangler. El guard de arquitectura debe comparar código contra configuración,
   y el test runtime debe usar el nombre literal/configurado, no importar la misma
   constante que pretende comprobar. Un batch desconocido nunca se confirma y
   pierde silenciosamente: produce señal operativa y una política explícita de
   retry/DLQ.
2. **Relayer CCTP recuperable.** En Payments, persistir el broadcast antes de
   esperar receipt; recuperar una ejecución previa consultando `usedNonces`, tx y
   eventos on-chain; y tratar la chain como fuente de verdad cuando D1 quedó
   atrasado. Añadir fault injection para crash después de broadcast y después de
   receipt, sin segundo mint ni operación atrapada en `processing`.
3. **Nonce/concurrencia del signer.** Serializar envíos por signer+chain mediante
   lease durable o un nonce manager con recuperación; justificar y probar
   `max_concurrency`. Ocho jobs simultáneos del mismo relayer no pueden reemplazar
   ni pisar sus nonces.
4. **Contabilidad CCTP real.** Liquidar con el `mintedAmount` decodificado, no con
   el mínimo esperado del attempt; registrar fee de red real, diferencia y
   `overpaid`, y emitir esos valores coherentes en ledger, API y webhook.
5. **Webhooks realmente at-least-once.** Recuperar leases `processing` vencidos,
   mantener idempotencia lógica por `event_id`, probar crash entre claim/HTTP/
   persistencia y asegurar retry/DLQ. El backend y las guías deben acordar el
   formato `GatoPago-Signature: v1=<hex>` y enviar/documentar el mismo header de
   event ID.
6. **Rotación criptográfica de webhooks.** Descifrar por `secret_key_id` usando un
   keyring/versionado; conservar claves antiguas hasta re-encriptar y verificar
   todos los endpoints. Ninguna rotación puede invalidar secretos existentes.
7. **Idempotencia concurrente.** Reemplazar read-before-insert de creación de
   intents por una operación atómica o recuperación segura de unique conflict.
   Dos requests simultáneos con el mismo `Idempotency-Key` deben devolver el mismo
   recurso y nunca un `500`.
8. **Cutover ejecutable y sin carrera.** Introducir modo bootstrap/sync-off. El
   orden será: backup y freeze acotado; crear/migrar Payments D1; desplegar
   Payments compatible sin sync; importar data-only sobre base vacía y verificar;
   fijar el SHA-256 del import con bootstrap todavía activo; activar Payments;
   habilitar sync/outbox; desplegar App caller con Service Binding; validar N/N-1;
   y solo después apuntar clientes. El target del binding siempre existe antes
   del caller, el outbox `0033` no puede poblar la base antes del import y no hay
   una combinación válida con App legacy y Payments escribiendo a la vez.
9. **Preflight fail-closed.** Corregir `legacySafety`/`ownership`, verificar nombre
   de Queue en código vs. Wrangler, target de Service Binding, D1 vacía antes del
   import, estado bootstrap, checksum runtime y orden de migraciones. HTTP/RPC,
   Queue y Cron comparten el mismo gate D1; cualquier campo ausente,
   `undefined` o divergente bloquea el corte. Conteos remotos son evidencia
   fechada, no constantes documentales. La igualdad exacta con el snapshot se
   exige antes de abrir el target; desde `syncing/cutover`, los conteos pueden
   crecer y el invariante durable pasa a ser el checksum base atómico.
10. **Documentación operable y única.** Usar el nombre remoto real
    `gatopago-payments-api` en todos los comandos de secrets/deploy; mantener CCTP
    personal en App y CCTP merchant en Payments en arquitectura, runbook,
    diagramas y deploy; corregir ejemplo de firma/event ID; volver a renderizar
    PlantUML y bloquear drift. No puede haber dos órdenes de cutover distintos.

#### 3B. Checkout público

1. Refactor del `PayPage` y métodos de pago, manteniendo la máquina de estados en
   módulos de checkout y no otra vez inline.
2. Apuntar checkout y dashboard directamente a Payments; retirar proxies solo
   después de confirmar telemetría y ausencia de clientes antiguos.
3. Wallet externa EIP-1193 únicamente cuando el navegador ya expone el provider,
   mediante una extensión o el navegador integrado de la propia wallet. Si no
   existe provider, mostrar instrucciones para abrir el link allí o usar saldo
   GatoPago; no cargar SDKs, relays ni proveedores externos de conexión.
4. Capability por sesión y firma del payer antes de reservar; lectura/registro/
   cancelación scopeadas. El hash sólo se persiste después de validar receipt,
   sender, router y evento por RPC de Payments.
5. Flujos local/CCTP, simulación, fallback de permit y resume de attempt.
6. Copy ES/EN y accesibilidad teclado/móvil.

#### 3C. Gates de aceptación de Fase 3

- [x] Tests negativos de drift Queue/Wrangler y Service Binding sin target.
- [x] Tests concurrentes de idempotency key y de nonces del relayer.
- [x] Fault injection CCTP en cada ventana de crash, incluido nonce ya usado.
- [x] Ledger/API/webhook prueban `mintedAmount`, fee real y sobrepago.
- [x] Webhook reclamado después de lease vencido, con firma y event ID verificables;
  rotación de clave mantiene endpoints viejos y nuevos.
- [x] Ensayo local compuesto de cutover y rollback con bootstrap, base vacía,
  import único, checksum fijado y verificado en runtime, guards de transición,
  outbox y compatibilidad N/N-1.
- [x] `pnpm verify:all`, auditoría, E2E, restore drill, contratos, diagramas y
  release artifacts repetidos después de las correcciones posteriores.
- [ ] Con autorización separada para operar remotamente: preflight fail-closed,
  backup, creación/migración/import, deploy target→caller, health y smokes. Sin
  autorización, la fase puede cerrar solo su componente local y queda la promoción
  marcada como pendiente.

**Evidencia histórica previa a la auditoría (25-08-2026):** `pnpm verify:all` pasó sobre la
implementación anterior; después del ajuste final de recuperación volvieron a pasar
`pnpm verify`, los 28 E2E aplicables (10 omisiones de matriz), auditoría,
release-artifact y split/restore D1. App terminó con 252 pruebas unitarias + 22
runtime; Payments con 43 + 16. `pnpm test:fork` terminó con 197 aprobadas, 0
fallos y 0 omisiones, incluidas 6 pruebas fork sobre las tres testnets. Coverage
ejecutó 187 pruebas instrumentadas y Foundry informó 4 omisiones de suites/casos
fork en ese gate.

**Evidencia local posterior a la auditoría (26-08-2026):** `pnpm verify:all`
vuelve a pasar. App: 253 unitarias + 22 runtime. Payments: 51 + 19. Playwright:
30 aprobadas + 10 omisiones de matriz. Audit: 0 vulnerabilidades conocidas.
D1: restore de 59 tablas y checksum semántico con tamper negativo. Foundry:
191 aprobadas + 4 forks omitidos sin RPC. Sigue pendiente commit/CI, migración
`0006`, deploy y smoke remoto.

**Segunda revisión local (26-08-2026):** reabrió el gate porque el primer reset
A→B esperaba la respuesta de B, el helper RPC sólo duplicaba Base, el checksum
histórico carecía de reemplazo auditable y `DEPLOY.md` permitía evitar el guard.
El candidato actual remonta toda la página por identidad de ruta, prueba dos RPC
por las tres redes, exige una D1 nueva con export target verificado y fuerza los
entrypoints protegidos. La verificación integral de este segundo delta queda
registrada con `pnpm verify:all` en exit 0: incluye la regresión A→B en desktop y
mobile, split/restore semántico, guards de deploy y las suites completas citadas
arriba. Sigue siendo evidencia local, no una aprobación de producción.

**Cierre local anterior, ahora reabierto:** ningún job App se pierde por drift de nombre; CCTP y webhooks se
recuperan tras crash sin duplicación económica; nonces concurrentes son seguros;
ledger/API/webhook reflejan el monto realmente acuñado; idempotencia concurrente
y rotación de claves están probadas; el runbook tiene un único cutover ejecutable;
y el mismo link admite pago sin login con wallet externa o saldo GatoPago. La
integración de contratos en las tres testnets ya tiene prueba fork viva; todavía
falta el E2E completo contra Workers promovidos. El
cierre local/testnet no equivale a deploy ni a readiness de mainnet.

### Fase 4 — reconciliación y evidencia E2E real (3–5 días)

- Evidencia on-chain/testnet de watchers multired, settlement y webhooks ya
  endurecidos en Fase 3; Fase 4 no posterga su corrección básica.
- Pruebas de browser crash, tx no registrada, relayer sin gas, Iris/RPC caído,
  doble pago y sobrepago.
- Observabilidad por chain/route y runbook.
- Medir lag, CPU/memoria, tamaño de bundle y exposición de la clave de relayer;
  extraer `settlement-consumer` únicamente si se activa un gate de §5.6.

**Cierre:** cada prueba deja evidencia de source tx, CCTP message, destination tx,
estado D1 y webhook; cero operaciones sin atribuir.

### Fase 5 — gate de producción

- Auditoría externa del delta de contratos.
- Fork tests de las tres mainnets con contratos/USDC/CCTP reales.
- Cero `TODO_DEPLOY`, keys segregadas, owners aceptados y pauses ensayados.
- Soak test estable en las tres testnets.
- Activación gradual: Arbitrum → Base → Avalanche mediante flags; no las tres en
  la misma hora.
- Límites de monto/volumen iniciales definidos por riesgo de negocio.

**Estimación orientativa para una persona:** 5–7 semanas hasta un candidato de
producción, más el tiempo de auditoría externa y correcciones. No es una promesa
de fecha.

## 9. Matriz mínima de pruebas

### Contratos

- Replay de intent/attempt, firma/payer/merchant/chain/monto/fee manipulados.
- Expiración y `validAfter`.
- Fee cap, redondeo, monto mínimo garantizado y `maxCctpFee` extremo.
- Reentrancy y tokens maliciosos en mocks.
- Pausa, rotación de signer/owner/treasury y permisos negativos.
- Conservación: router queda con saldo cero tras éxito/revert.
- Permit real y fallback en cada fork.
- Dirección de cuenta determinista en las tres redes.
- P256/passkey y gas de verificación en Base/Avalanche si se prueba account infra.

### Backend

- Tests de arquitectura impiden que App importe repositorios/bindings de
  Payments y viceversa.
- Contratos RPC/job N y N-1; caller nuevo contra receptor anterior y receptor
  nuevo contra caller anterior.
- App Worker caído mientras checkout y `/v1` operan; Payments caído mientras
  Home/cuenta siguen operativos y links fallan de forma explícita.
- Copy/cutover conserva IDs, conteos y checksums; restore independiente de
  `GATOPAGO_DB` y `PAYMENTS_DB`.
- Mensaje Queue duplicado, retry agotado y DLQ; ninguna duplicación económica ni
  doble webhook lógico.
- Circle fee API lenta/caída/malformada; nunca usar un valor hardcodeado oculto.
- Base Fast/Standard; Avalanche Standard-only.
- Attempt creado antes del calldata.
- Cliente cierra después del tx y antes de `/register`.
- Mismo tx registrado dos veces; mismo attempt ejecutado dos veces.
- Dos attempts en chains distintas; segundo settlement produce sobrepago, no se
  pierde.
- Reorg/receipt reverted, Iris sin attestation y mint reintentable.
- Webhook exactamente una vez lógicamente, con reintentos físicos idempotentes.

### Navegador

- Extensión EIP-1193 y navegador móvil integrado. Sin provider, se muestran
  instrucciones para abrir el link dentro de la wallet; no existe conexión
  remota mediante SDK, relay, QR o deep-link de terceros.
- Capability ausente/incorrecta, firma de otro payer, replay con otra capability,
  hash inexistente, receipt revertido, sender/router/evento manipulados y
  expiración de `submitted` sin evidencia.
- Wallet rechaza conexión, switch, permit, approve o pago.
- USDC insuficiente y gas nativo insuficiente.
- Chain equivocada/cambio de cuenta durante la quote.
- Quote expira entre review y firma.
- Refresh en cada step.
- ES/EN, teclado, lector de pantalla y viewport móvil.

## 10. Operación y rollout

- Workers, D1, Queues, DLQ, secrets, dashboards y health checks tienen nombres
  y ownership separados; ningún deploy copia todo el set de secretos al otro.
- Primer cutover: crear/validar `PAYMENTS_DB`, desplegar Payments de forma
  compatible, luego App con el Service Binding y finalmente cambiar clientes.
  Nunca desplegar primero un caller que exige un método RPC inexistente.
- Los contratos internos cambian de forma aditiva y toleran version skew durante
  rollout gradual. Las migraciones D1 no se versionan junto al Worker: backup y
  compatibilidad de schema se verifican antes de promover código.
- Kill switches separados para `local`, `base_cctp` y `avalanche_cctp`.
- Métricas: quote success, wallet connect, simulation fail, approval abandon,
  source included, attestation latency, mint latency, settlement success y
  overpayment por chain.
- Alertas: fee API stale, RPC mismatch, relayer gas bajo en Arbitrum, attempts
  processing fuera de SLA, message mismatch y balance no-cero en router.
- Owner final en multisig/cold control; pause guardian sin permiso de unpause ni
  retiro; signer de autorizaciones separado y, de ser viable, respaldado por un
  signer remoto/HSM en lugar de una clave exportable en el Worker.
- Runbook de `manual_complete` conserva la propiedad permissionless de CCTP.
- Rollback de aplicación = apagar chain/route y volver Worker/frontend. Los
  contratos no se “rollbackean”: se pausan y se despliega una versión nueva.

## 11. Defaults recomendados

Estos defaults permiten avanzar sin otra ronda de diseño; solo deben cambiar si
hay una razón de negocio concreta:

1. **Home/settlement:** Arbitrum.
2. **Activo:** USDC nativo únicamente.
3. **Monto del intent:** neto mínimo del comercio; fees encima para el pagador.
4. **Base:** Fast por defecto, Standard como opción económica.
5. **Avalanche:** Standard únicamente.
6. **Fee GatoPago:** `free-default` (0) en toda ruta. Los caps de contrato son
   capacidad preventiva, nunca política ni promesa de cobro.
7. **Wallet GatoPago:** operativa solo en Arbitrum durante fase 1.
8. **Base/Avalanche:** rails de aceptación, no saldos agregados.
9. **CCTP:** directo, relayer propio, caller permissionless, sin Hooks.
10. **Activación mainnet:** progresiva y feature-flagged.
11. **Backend Fase 2:** dos Workers públicos, dos D1 físicos y dos Queues; App →
    Payments es la única dependencia RPC.
12. **Tercer Worker:** no se crea sin activar y documentar un gate medido de
    §5.6.
13. **Sponsorship:** adapter Parmelia/ERC-7677/self-funded; ningún fallback
    cambia el paymaster después de pedir la firma y toda rotación drena por
    provider + dirección exacta.

## 12. Estrategia multichain después del checkout

La expansión debe avanzar por niveles; “agregar una chain” no significa activar
todas las funciones a la vez.

### Nivel 1 — aceptación multired (este plan)

- La cuenta, balance y programación viven en Arbitrum.
- Base/Avalanche solo originan pagos interactivos.
- USDC termina consolidado de verdad en Arbitrum.
- Es el nivel que se puede lanzar y explicar con honestidad en la primera salida.

### Nivel 2 — depósitos guiados y vista assets-first

- Reutilizar el router para “Agregar dinero desde otra wallet”.
- La UI muestra `USDC`, no tres filas de USDC por chain; la chain vive en los
  detalles de la operación porque el saldo quedó realmente consolidado.
- AVAX puede conservar Avalanche como home si se incorpora más adelante. El home
  de ETH se decide con datos; no se agrega virtualmente antes.
- Retiros a una red elegida se expresan como un nuevo intent de salida.

### Nivel 3 — cuenta GatoPago plenamente multichain

Solo habilitar cuentas/paymaster en Base o Avalanche cuando cada red tenga:

1. factory/verifier/implementation reproducibles y manifests congelados;
2. EntryPoint/bundler compatibles y fork/E2E de passkeys;
3. benchmark P256 y límites de paymaster propios de su moneda nativa;
4. indexer, finalidad, reorg handling, RPCs y alertas operadas;
5. recovery y upgrades coordinados sin asumir que el estado se replica;
6. demanda real que justifique esa obligación permanente.

Antes de llegar a esa duplicación, ejecutar un spike separado de Circle Gateway
para usuarios recurrentes o treasury. El gate no es solo técnico: debe comparar
con CCTP el tiempo total incluyendo el primer depósito, costo por patrón de uso,
recuperación operativa y exposición del EOA delegado. Mientras la delegación no
pueda limitarse por monto, destino y expiración, Gateway no debe controlar fondos
de la smart account principal de GatoPago.

Incluso en Nivel 3, un “saldo total” solo puede mostrarse como disponible si el
router sabe ejecutarlo bajo límites de costo/tiempo explícitos. La alternativa
preferida para USDC sigue siendo consolidarlo, no esconder fragmentación.

## 13. Qué queda fuera de esta primera mejora

- ETH/AVAX/otros tokens como input y swap automático a USDC.
- Fiat, QR bancario, tarjetas, payroll, treasury o subscriptions.
- ERC-7579/7715, session keys, agentes y pagos delegados.
- Un settlement executor para output cross-chain exactamente igual al centavo.
- Saldo universal virtual o full wallet en Base/Avalanche.
- Depósitos planos desde exchanges en cualquier red con consolidación automática.
- “Any currency, any chain”.

Estas extensiones pueden montarse después sobre `PaymentIntent` y
`PaymentAttempt`; no deben retrasar la primera evidencia con comercios.

## 14. Fuentes externas verificadas

- Circle confirma CCTP Standard en Arbitrum, Base y Avalanche; Fast en Arbitrum
  y Base, no en Avalanche; dominios 3, 6 y 1:
  <https://developers.circle.com/cctp/concepts/supported-chains-and-domains>
- Circle exige consultar fees actuales y no hardcodearlas:
  <https://developers.circle.com/cctp/concepts/fees>
- USDC nativo oficial en las seis redes:
  <https://developers.circle.com/stablecoins/usdc-contract-addresses>
- Contratos CCTP v2 oficiales por mainnet/testnet:
  <https://developers.circle.com/cctp/references/contract-addresses>
- Semántica de `destinationCaller`, `maxFee` y finality 1000/2000:
  <https://developers.circle.com/cctp/references/contract-interfaces>
- Gateway, su modelo de saldo unificado y comparación oficial con CCTP:
  <https://developers.circle.com/gateway>
- Redes Gateway y tiempos de finalidad de depósitos:
  <https://developers.circle.com/gateway/references/supported-blockchains>
- Fees Gateway (0.5 bps cross-chain más gas del source):
  <https://developers.circle.com/gateway/references/fees>
- Gateway con smart accounts requiere un EOA delegado; `addDelegate` funciona
  como allowance completo del token y la revocación no invalida intents firmados:
  <https://developers.circle.com/gateway/howtos/manage-delegates>
  <https://developers.circle.com/gateway/references/contract-interfaces-and-events>
- EntryPoint v0.9 y address oficial:
  <https://github.com/eth-infinitism/account-abstraction/releases/tag/v0.9.0>
- Cloudflare Service Bindings: RPC privado entre Workers, despliegues separados,
  límite de invocaciones y advertencia de que Access no se propaga:
  <https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/>
- Límites de Workers y D1; D1 es single-threaded por base y escala
  horizontalmente con bases menores:
  <https://developers.cloudflare.com/workers/platform/limits/>
  <https://developers.cloudflare.com/d1/platform/limits/>
- `D1.batch()` ejecuta una transacción y revierte la secuencia si falla una
  sentencia:
  <https://developers.cloudflare.com/d1/worker-api/d1-database/>
- Cloudflare Queues entrega al menos una vez; los consumidores de dinero deben
  deduplicar mediante IDs/idempotency keys:
  <https://developers.cloudflare.com/queues/reference/delivery-guarantees/>
- Los despliegues graduales pueden producir version skew entre Workers unidos
  por Service Binding:
  <https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/>

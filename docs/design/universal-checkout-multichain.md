# Plan de implementación — Checkout universal y aceptación USDC en tres redes

**Fecha:** 23 de agosto de 2026  
**Estado:** propuesta ejecutable; no implica despliegue ni cambia por sí sola el diseño vigente  
**Primera salida objetivo:** Arbitrum como red hogar; cobros desde Arbitrum, Base y Avalanche  
**Activo inicial:** USDC nativo

Este documento convierte la visión de intents, routing y settlement en un primer
corte de producto acotado. No propone transformar toda la aplicación en una
wallet multichain antes de mainnet.

Mientras esta propuesta no sea aceptada e implementada, el diseño operativo
vigente sigue siendo [`cross-chain.md`](./cross-chain.md) y la realidad del código
prevalece sobre ambos documentos.

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
| Saldo GatoPago en Arbitrum | UserOperation actual + passkey | USDC en Arbitrum |
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

## 1. Hechos actuales que condicionan el plan

1. El runtime sigue siendo mono-chain: `CHAIN_KEY` y `VITE_CHAIN_KEY` eligen una
   única red activa. `getPublicClient`, cuentas, balance, paymaster, indexer y Home
   dependen de esa red.
2. `PayPage.tsx` es público para leer el link, pero el botón de pago exige login y
   termina en `/pay/prepare`; la wallet externa no está integrada en el checkout.
3. El Flow B existe en backend y contrato, pero
   `GET /v1/payment_intents/:id/onchain` exige la clave secreta del comercio. No
   es un endpoint que pueda consumir de forma segura el navegador del pagador.
4. El inbound CCTP público ya acepta una wallet externa y ya registra la operación
   antes del burn, pero vive separado en `/cc/:recipient` y no está vinculado a un
   `PaymentIntent`.
5. `payment_intents` no guarda red de settlement ni intentos de ejecución. Su
   `tx_hash` único deja de ser suficiente cuando hay burn en origen y mint en
   destino.
6. `crosschain_operations` ya modela source/destination chain, attestation,
   retries y mint; se debe reutilizar, no reescribir.
7. La quote CCTP actual usa constantes (`1.3 bps` estimado y `10 bps` de
   `maxFee`). Para producción debe consultar la API de fees de Circle. Circle
   advierte explícitamente que las fees pueden cambiar y no deben hardcodearse.
8. El código ofrece `fast` por defecto también a Fuji. Circle soporta Fast como
   origen en Arbitrum y Base, pero no en Avalanche; Avalanche debe usar Standard.
9. Los contratos tienen una base saludable: en este corte `forge test` pasa
   **124 tests**, con **1 fork test omitido** por falta de RPC. Eso valida pruebas
   unitarias, no compatibilidad real en las tres redes ni readiness de mainnet.
10. `DeploymentRoles` solo trata `42161` como mainnet. Base (`8453`) y Avalanche
    (`43114`) quedarían fuera de la separación obligatoria de roles.
11. El deploy del paymaster usa los mismos valores en `ether` para stake, depósito
    y cap en cualquier red. Eso no es una política económica portable a AVAX.
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

### 5.2 Datos — migración propuesta `0030_payment_attempts.sql`

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

Añadir `payment_attempt_id` nullable y único a `crosschain_operations`. Esa tabla
continúa siendo la máquina CCTP detallada; `payment_attempts` es la vista de
orquestación común.

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

Extraer del actual `storage.ts` y añadir:

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
- Parametrizar el watcher del router por chain y usar el journal/checkpoints
  existentes con `chain_id`; no crear un indexador paralelo sin reorg handling.
- El evento del router permite encontrar un attempt aunque el cliente no haya
  llamado `/register`.
- La transición `processing → paid` y el outbox de webhook ocurren en un batch
  D1 idempotente.
- Emitir `payment.overpaid` si un segundo settlement o un output superior al
  esperado aparece. Nunca perder esa evidencia aunque el intent ya esté `paid`.
- Un attempt fallido no mata el intent: si no hubo movimiento y el link no
  expiró, vuelve a permitir una nueva quote.

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

Crear un `CheckoutWalletProvider` aislado del sistema de passkeys de GatoPago:

- wagmi/viem para conexiones y writes;
- injected/EIP-6963 para extensiones;
- WalletConnect para móvil/QR;
- connector adicional solo si las pruebas con usuarios lo justifican.

`VITE_WALLETCONNECT_PROJECT_ID` es configuración pública del cliente, pero debe
existir en el entorno de checkout y restringirse al dominio permitido en el
proveedor.

No reemplazar Firebase, passkeys ni el transporte ERC-4337 del resto de la app.
El provider vive solo alrededor del checkout público para contener bundle y
estado global.

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
| Backend | `server/src/chain.ts` | viem chains para Arbitrum/Base/Avalanche y sus testnets. |
| Backend | `server/src/services/clients.ts` | Factory de clients de pago por chain id; clients actuales siguen en home chain. |
| Backend | `server/src/env.ts`, `runtimeConfig.ts` | Flags/RPC multired, HTTPS/mainnet, code y chain-id preflight. |
| Backend | nuevo `server/src/routes/checkout.routes.ts` | API pública del checkout; auth y `/v1` permanecen separados. |
| Backend | `server/src/routes/links.routes.ts`, `v1.routes.ts` | Todo link crea intent; respuestas incluyen settlement sin romper campos actuales. |
| Backend | `server/src/services/storage.ts` | Extraer attempts; no seguir creciendo el hotspot. |
| Backend | nuevos servicios de §5.3 | Policy/quote/auth/reconciliation por responsabilidad. |
| Backend | `server/src/services/crosschainRelayer.ts` | Enlazar CCTP con attempt/intent y validar el nuevo sender router. |
| Backend | `server/src/services/eventJobs.ts`, `eventScheduler.ts` | Watcher particionado por source chain con checkpoints. |
| Datos | nuevo `server/migrations/0030_payment_attempts.sql` | Intents enriquecidos, attempts y relación CCTP. |
| API | `shared/errors.ts`, `docs/openapi.yaml`, `docs/api.md` | Errores estables, endpoints públicos, objetos y webhooks nuevos. |
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

- Implementar routers y hardenings de §4.
- Corregir `DeploymentRoles` y parametrizar deploy.
- Desplegar/redeployar solo en Arbitrum Sepolia, Base Sepolia y Fuji.
- Verificar source y codehash; guardar manifests.

**Cierre:** unit/fuzz/invariant verdes y una llamada real por cada router en su
testnet. Un deploy exitoso sin transacción real no cierra la fase.

### Fase 2 — datos, quote e intent engine (4–6 días)

- Aplicar la migración local y probar backup/restore.
- Crear intent por todo link nuevo y compatibilidad para links anteriores.
- Implementar fee CCTP viva, attempts, EIP-712 y API pública.
- Generalizar clients/watchers solo en la frontera de pagos.

**Cierre:** API tests de idempotencia, expiry, una tentativa activa, fee stale,
chain disabled y autorización manipulada.

### Fase 3 — checkout público (4–6 días)

- Refactor del `PayPage` y métodos de pago.
- Wallet injected + WalletConnect.
- Flujos local/CCTP, simulación, fallback de permit y resume de attempt.
- Copy ES/EN y accesibilidad teclado/móvil.

**Cierre:** el mismo link se paga sin login desde las tres testnets y con saldo
GatoPago en Arbitrum Sepolia.

### Fase 4 — reconciliación y evidencia E2E (3–5 días)

- Watchers multired, settlement y webhooks.
- Pruebas de browser crash, tx no registrada, relayer sin gas, Iris/RPC caído,
  doble pago y sobrepago.
- Observabilidad por chain/route y runbook.

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

**Estimación orientativa para una persona:** 4–6 semanas hasta un candidato de
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

- Desktop injected y móvil WalletConnect.
- Wallet rechaza conexión, switch, permit, approve o pago.
- USDC insuficiente y gas nativo insuficiente.
- Chain equivocada/cambio de cuenta durante la quote.
- Quote expira entre review y firma.
- Refresh en cada step.
- ES/EN, teclado, lector de pantalla y viewport móvil.

## 10. Operación y rollout

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
6. **Fee GatoPago cross-chain piloto:** 0; medir costos/conversión antes de fijar.
7. **Wallet GatoPago:** operativa solo en Arbitrum durante fase 1.
8. **Base/Avalanche:** rails de aceptación, no saldos agregados.
9. **CCTP:** directo, relayer propio, caller permissionless, sin Hooks.
10. **Activación mainnet:** progresiva y feature-flagged.

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

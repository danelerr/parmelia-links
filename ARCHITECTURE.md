# GatoPago - Arquitectura del Proyecto

> Actualizado: agosto 2026. Índice y precedencia: [`docs/README.md`](./docs/README.md).
> Complementos: [mapa visual y diagramas PlantUML](./docs/architecture/README.md),
> [diseño cross-chain](./docs/design/cross-chain.md),
> [`docs/api.md`](./docs/api.md) (API pública `/v1`),
> [`contracts/AUDIT.md`](./contracts/AUDIT.md) (contratos) y
> [`DEPLOY.md`](./DEPLOY.md) (runbook).

## Resumen

**GatoPago** es una web app de pagos cripto sobre **Account Abstraction (ERC-4337, EntryPoint v0.9)**. La red activa es **Arbitrum** (Sepolia para testnet, One para producción), elegida por su soporte de **RIP-7212** (verificación P256/passkey barata, ~3,450 gas) y su gas bajo. El código es **portable**: cambiar de cadena es agregar una entrada de configuración y desplegar los contratos.

El producto combina:

- **Firebase Auth** para identidad: **Google** y **magic links nativos de Firebase**. El Worker conserva Turnstile/rate limits y solicita el enlace a Firebase; no gestiona contraseñas, códigos ni un proveedor SMTP externo.
- **Passkeys WebAuthn (P256)** para firmar operaciones de la wallet en el dispositivo.
- **Smart accounts `AccountWebAuthnV2`** (MultiSigner ERC-7913 + UUPS + recovery con guardian) desplegadas por factory.
- **Dos Cloudflare Workers, dos D1 y dos Queues**: App para identidad/cuentas/UserOperations y Payments para checkout/intents/settlement/webhooks.

Funcionalidades de producto: links de cobro, pago a username/QR/manual, **swaps internos** (Uniswap v3/v4 vía Universal Router), **cross-chain USDC vía Circle CCTP v2** (enviar a otra red desde la app + checkout público `/cc/:username` para cobrar desde otras redes), **contactos e invitaciones con código de referido**, **extracto con filtros compartibles por URL**, **comprobantes**, **notificaciones push** ("te pagaron"), **i18n ES/EN**, y una **API de cobros `/v1` estilo Stripe** (payment intents, webhooks firmados, sandbox) con su **dashboard de comerciantes**.

El backend prepara y transmite UserOperations, pero **no custodia la clave de firma del usuario**. La autorización real de pagos ocurre con WebAuthn en el navegador.

## Topología de backend vigente desde Fase 2

La unidad de escala no es el dashboard. El dashboard y el checkout son clientes
del dominio Payments; no existe un “Worker del dashboard”. La frontera operativa
es la siguiente:

| Deployable | Base y datos propietarios | Responsabilidad |
|---|---|---|
| App API (`server/`, deploy remoto `server`) | `GATOPAGO_DB`, `parmelia-scheduled-jobs` | Firebase/magic links/passkeys, smart accounts, UserOperations, Home/ledger, swaps, Earn, contactos y card. |
| `gatopago-payments-api` (`payments-worker/`) | `PAYMENTS_DB`, `gatopago-payment-jobs` | merchants/API keys, links, intents, quotes, attempts, routing local/CCTP, settlement, eventos y webhooks. |

App tiene un único Service Binding hacia Payments para compatibilidad y para
enviar comandos versionados e idempotentes. Payments no llama a App, verifica
Firebase por sí mismo y nunca recibe `GATOPAGO_DB`. Las referencias entre ambos
dominios (`owner_uid`, `payment_attempt_id`) son IDs lógicos, no foreign keys.
Cada transición económica y su outbox de webhook viven en el mismo batch de
`PAYMENTS_DB`; la sincronización entre Workers usa outboxes durables y no simula
una transacción distribuida.

El nombre físico `server` y su Queue histórica se conservan durante este corte:
renombrarlos simultáneamente duplicaría secretos, Durable Objects, URLs y estado
sin mejorar el aislamiento. `gatopago-app-api` describe el rol lógico; un cambio
de nombre posterior debe hacerse detrás de un hostname estable y como migración
operativa independiente.

`gatopago-app-api` no es un BFF genérico del dashboard: es el backend de dominio
de la app. Su proxy de `/links`, `/checkout`, `/v1` y `/merchant` es una capa de
compatibilidad N-1 y no posee lógica ni datos económicos. `/pay` y `/crosschain`
siguen en App porque también ejecutan transferencias, fondeo y CCTP personales;
solamente el subflujo de `/pay` que consume un link reservado llama a Payments
mediante el contrato RPC versionado. Los
clientes nuevos de dashboard/checkout hablan con Payments. Si más adelante se
necesita un hostname único, caché o protección antiabuso común, se puede añadir
un gateway edge sin D1 ni reglas de negocio; crear hoy un tercer BFF sólo añade
otro deploy y otro salto síncrono.

La partición actual es **física por dominio**, no sharding horizontal:

- localmente existen dos schemas, dos historiales de migración y un cutover
  data-only verificable; remotamente `PAYMENTS_DB` sigue sin provisionarse y su
  config conserva un UUID centinela;
- los archivos Wrangler forman una máquina de estados de un solo escritor; App
  y Payments tienen guards de deploy, y desactivar bootstrap exige un SHA-256
  que coincida con `payment_migration_control` en cada entrada HTTP/RPC/Queue/Cron;
- `payment-jobs` sí se particiona lógicamente por chain/recurso y los reintentos
  diferidos se compactan en `PAYMENT_JOB_SCHEDULER` antes de llegar a Queue;
- una sola `PAYMENTS_DB` es la topología inicial. Sus hot paths tienen índices y
  un gate `EXPLAIN QUERY PLAN`; `max_concurrency=8` limita presión concurrente
  sobre D1 y proveedores;
- el siguiente corte, sólo con saturación medida después de optimizar queries y
  batching, es sharding por merchant detrás del repositorio. No es crear más
  Workers HTTP: una D1 individual seguiría siendo el cuello de escritura.

El tercer Worker de settlement no se crea por anticipación. Sólo se extrae si
métricas sostenidas muestran que el consumidor de pagos agota CPU/subrequests,
que sus retries afectan la latencia HTTP o que necesita una clave/perímetro de
seguridad independiente. Separarlo entonces no exige volver a partir la base:
el contrato Queue y la propiedad de `PAYMENTS_DB` ya están definidos.

### Economía y patrocinio extensibles (Fase 2.1)

La decisión comercial vigente es **cero comisión de GatoPago**. Esa decisión no
está mezclada con la capacidad técnica de los contratos:

| Capa | Responsabilidad | Invariante |
|---|---|---|
| `PAYMENT_FEE_POLICY_JSON` | Reglas versionadas y acotadas por merchant, modo, chain, route y monto | Ausente o vacío = `free-default`, 0 bps. |
| `shared/networks.ts` | Capacidad inmutable del router ya desplegado | Un cap es un techo, nunca una tarifa activa. |
| Quote/attempt | Snapshot de policy, regla, bps, bearer, recipient y cap | No cambia aunque luego cambie la configuración. |
| `payment_fee_ledger` | Dos líneas: plataforma y red, quoted vs actual | Settlement/webhook no se completa sin evidencia económica. |
| Preflight onchain | Código, signer, pause, USDC, treasury y cap | Una divergencia corta antes de firmar. |

Una regla con fee positiva requiere simultáneamente
`PAYMENT_ROUTER_PREFLIGHT_ENABLED=true`, un recipient válido, una treasury
onchain idéntica y un cap desplegado suficiente. La policy nunca puede convertir
silenciosamente una ruta gratuita en pagada. Los fees CCTP de Circle se muestran
por separado: son costo de red, no ingreso de GatoPago.

Las operaciones propias de la app (swap y cross-chain personal) conservan un
switch maestro distinto, `GATOPAGO_FEES_ENABLED=false`. Un valor BPS aislado no
activa nada; si el switch se habilita, configuración, cap y treasury fallan
cerrado. La compatibilidad merchant N-1 permanece forzada a 0 y no reutiliza esa
configuración: checkout tiene una sola autoridad económica en Payments.

El patrocinio ERC-4337 usa `SponsorshipProvider`, no una dependencia directa de
`ParmeliaPaymaster`. Hay tres adapters: `parmelia`, servicio ERC-7677 y
`self-funded`. Un fallback reconstruye y reestima una UserOperation todavía sin
firma. `paymasterAndData` forma parte del digest ERC-4337: después de `/prepare`
no se cambia proveedor ni contrato; se crea otra preparación y el usuario firma
de nuevo. `pending_payments` guarda provider y paymaster address exactos para
canary, drenaje e incidentes. Las smart accounts no dependen de una dirección de
paymaster, por lo que cambiarlo no migra cuentas.

---

## Stack Tecnológico

| Capa      | Tecnología                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Contratos | Solidity (solc pineado `0.8.28`), Foundry, OpenZeppelin v5 (ERC-7913 / ERC-7821 / UUPS)                                             |
| Cliente   | React 19, TypeScript 6, Vite 7, Tailwind CSS v4, react-i18next, Firebase (Auth + Messaging + Analytics), SWR, react-router-dom, qrcode.react, jsqr (lazy), html-to-image, sileo, Turnstile |
| Dashboard | React 19, Vite, SWR (`useSWRInfinite` para paginación), Firebase Auth — panel del comerciante para la API `/v1`                     |
| Servidor  | Hono, dos Cloudflare Workers, dos D1, dos Queues/DLQ, Durable Objects + Email Sending, viem, jose, SimpleWebAuthn                    |
| Shared    | Módulo TypeScript compartido: ABIs, redes/direcciones, tokens, config Uniswap/CCTP y **contrato de errores** (`errors.ts`)          |
| Red       | Arbitrum Sepolia (421614) - testnet activa. Arbitrum One (42161) - producción (contratos aún no desplegados). Base Sepolia - destino CCTP / legacy. |
| Deploy    | Cliente y dashboard en Vercel, servidor en Cloudflare Workers                                                                        |

---

## Estructura del Monorepo

```text
gatopago/
├── README.md / ARCHITECTURE.md / SECURITY.md / DEPLOY.md
├── docs/                    # índice, diseños, API, operaciones, auditorías y runbooks
│   ├── README.md / roadmap.md / api.md / openapi.yaml
│   ├── design/              # API, cross-chain y DeFi
│   ├── operations/          # integraciones
│   ├── reference/           # contratos técnicos auxiliares
│   ├── audits/              # evidencia fechada + histórico
│   └── runbooks/            # procedimientos operativos
├── package.json / pnpm-workspace.yaml
├── client/                  # SPA React (Vercel build desde esta carpeta)
│   ├── public/
│   │   ├── sw.js                 # service worker (PWA shell + FCM push)
│   │   └── manifest.webmanifest
│   └── src/
│       ├── App.tsx               # ruteo + protección + init analytics
│       ├── main.tsx              # registro del service worker (solo prod)
│       ├── components/           # Logo, ReceiptModal, Turnstile, ErrorBoundary, AmountInput,
│       │                         #   LinkButton, OptionCard, Skeleton, DesktopNotice, ...
│       ├── hooks/                # useNav (view transitions), useDialog (a11y de modales)
│       ├── lib/                  # api, notify, firebase, push, analytics, webauthn, format,
│       │                         #   authFetch, activeNetwork, networks, transactions, exportCard, hex
│       ├── locales/              # es.json / en.json (i18n completo, incl. err.*)
│       └── pages/                # Login, Onboarding, Home, CreateLink, PayPage, PaymentStatus,
│                                 #   ScanQR, Swap, Statement, Contacts, Deposit, Receive, Earn,
│                                 #   BinanceDeposit, CrosschainSend, CrosschainReceive, Settings
├── dashboard/               # panel de comerciantes (API keys, pagos, webhooks, sandbox)
│   └── src/pages/                # Login, Overview, Payments, PaymentDetail, ApiKeys, Webhooks, Events, Sandbox
├── server/                  # gatopago-app-api (Hono; App Worker)
│   ├── migrations/               # 0001..0035; sólo dominio App
│   └── src/
│       ├── index.ts              # middlewares + rutas + consumers de Queue
│       ├── chain.ts              # chainKey -> viem Chain
│       ├── middlewares/          # auth.ts (Firebase JWKS), apiAuth.ts (API keys sk_)
│       ├── routes/               # user, account, links, pay, transactions, swap, contacts,
│       │                         #   bridge, crosschain, v1 (API pública), merchant (dashboard)
│       └── services/             # storage(D1), account/UserOp/indexer y binding App -> Payments
│                                 #   sponsorship/providers, paymaster health, clients, keys,
│                                 #   validation, swap, uniswap, bridge, push, turnstile, indexer,
│                                 #   eventScheduler, eventJobs, apiError, logger
├── payments-worker/         # gatopago-payments-api (checkout + merchant API)
│   ├── migrations/               # schema Payments + snapshots/ledger económico
│   └── src/                      # routes, repositories, quote/auth engine, CCTP, watcher y webhooks
├── contracts/               # Foundry (V2 activo)
│   ├── src/                      # AccountWebAuthnV2, AccountFactoryV2, ParmeliaPaymaster,
│   │                             #   ParmeliaPaymentRouter, ParmeliaCrosschainRouter, ERC7913WebAuthnVerifier
│   ├── storage-layout/           # snapshots del layout (gate manual pre-upgrade, AUDIT M-3)
│   └── script/Deploy.s.sol       # deploy determinista CREATE2
└── shared/
    ├── index.ts                  # ABIs (compiladas) + erc20Abi
    ├── errors.ts                 # contrato de errores: ERR + ERROR_HTTP_STATUS (ver docs/reference/error-codes.md)
    ├── networks.ts               # fuente de verdad: redes, tokens, Uniswap, CCTP, direcciones, guards
    └── paymentContracts.ts       # RPC/Queue N y N-1; sin handlers, secretos ni bindings D1
```

---

## Portabilidad entre cadenas

Toda la configuración dependiente de la red vive en **`shared/networks.ts`**. No hay direcciones ni cadenas hardcodeadas en los handlers: el servidor resuelve todo con `getNetworkConfig(env.CHAIN_KEY)`.

Cada red declara `contracts: { entryPoint, factory, paymaster, verifier, paymentRouter, crosschainRouter, usdc, usdcDecimals }`, su lista de `tokens` whitelisted (USDC/ETH/WBTC), su `uniswap`, flags (`isTestnet`, `paymentRouterHasPermit`) y metadata (explorer, faucet). El registro CCTP (`CCTP_CHAINS`) vive en el mismo archivo, keyed por chainId.

**Guards fail-closed:** los placeholders `TODO_DEPLOY` (dirección cero) no pueden operarse — `assertContractsDeployed()` corta cualquier flujo del server que fuera a usar un contrato sin desplegar (`CONTRACT_NOT_DEPLOYED`). Los gates de seguridad que en testnet son opcionales (Turnstile, claves dedicadas por rol) **fallan cerrado cuando `isTestnet: false`**.

Para agregar una cadena:

1. Desplegar los contratos V2 con el script determinista.
2. Agregar una entrada en `NETWORKS` de `shared/networks.ts` (direcciones + tokens + uniswap + metadata).
3. Mapear la cadena a su `viem.Chain` en `server/src/chain.ts` (`CHAIN_MAP`).
4. Reflejar la metadata de presentación en `client/src/lib/networks.ts`.
5. Apuntar `CHAIN_KEY` (var del Worker) y `VITE_CHAIN_KEY` (cliente) a la nueva clave.

### Direcciones por red

| Contrato                | Valor                                                          |
| ----------------------- | -------------------------------------------------------------- |
| EntryPoint (v0.9)       | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` (canónico, igual en toda cadena) |
| USDC (Arbitrum One)     | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` (native Circle)    |
| USDC (Arbitrum Sepolia) | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` (Circle testnet)   |
| WBTC (Arbitrum One)     | `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` (8 dec)            |
| Verifier (Arb Sepolia)  | `0x14D5D46fc6ED1154F3719f87ae72C3020d4fb886` (V2)               |
| Factory (Arb Sepolia)   | `0xb97E923E27CB258012081446e4b436afd3974108` (V2)               |
| Paymaster (Arb Sepolia) | `0x913a1B51c4f5b1a458A56D0d700c956834cc1d15` (V2)               |
| PaymentRouter (Arb Sepolia) | `0xaF5a6856F65eab6bd8d0e403E4cFd49aD0c0c04f` (Flow B con permit) |
| Universal local router (Arb Sepolia) | `0x64e0B48A4D360B235C3fEDe2431D79413aebb7A4` |
| Universal CCTP router (Base Sepolia) | `0x961C08Bd5a11EFB7264B06d7f14a44FB4d9958Ba` |
| Universal CCTP router (Avalanche Fuji) | `0xd8289B87b155e8691Da192b12E12E2b592fE7D1E` |
| CrosschainRouter (Arb Sepolia) | `0xD089c3764a8F2E62eFDf280Eb2432c1dC647400c` (CCTP outbound endurecido) |
| Contratos (Arb One)     | _TODO: desplegar V2 y rellenar `shared/networks.ts`_            |

Por el deploy determinista (CREATE2 con salt fijo + solc pineado), los contratos obtienen la **misma dirección en toda cadena** si el bytecode es idéntico → cada usuario conserva **la misma dirección de wallet** entre cadenas. Universal Checkout mantiene la cuenta en Arbitrum y usa Base/Fuji solo como rails de aceptación durante la fase 1; las tres mainnets siguen desactivadas.

---

## Arquitectura Lógica

### 1. Cliente (React/Vite)
- Sesión vía Firebase: Google o magic link. Firebase emite y consume el enlace; el correo nunca se incluye en la URL. En otro dispositivo el usuario debe confirmarlo. Recovery añade un challenge opaco, ligado al UID y consumible una sola vez, antes de emitir una prueba de step-up acotada.
- Onboarding obligatorio cuando hay login pero aún no hay wallet; verificación **Turnstile** antes de crear cuenta.
- Crea passkeys (`createPasskey`) y firma UserOps (`signWithPasskey`).
- Consume la API con la capa tipada **`lib/api.ts`** (`apiFetch` → `ApiError` con `error_code`) y centraliza avisos en **`lib/notify.ts`** (mapea `error_code → t("err."+code)`).
- Push opt-in (`lib/push.ts`), eventos de funnel (`lib/analytics.ts`), PWA instalable, i18n ES/EN.

### 2. Workers API (Hono/Cloudflare)
- Ambos verifican Firebase ID tokens directamente con JWKS de Google. Sólo Payments autentica `/v1` con API keys `sk_` (hash SHA-256 en `PAYMENTS_DB`).
- App conserva usuario, cuenta, ejecución, swaps, contactos, historial y cross-chain personal. Payments expone `/links`, `/checkout`, `/v1`, `/merchant` y el CCTP específico de cobros.
- Despliega smart accounts; construye UserOps ERC-4337 patrocinadas y las envía con `handleOps`.
- App no usa Cron Trigger: sus transiciones registran trabajo en
  `EventJobScheduler`, un Durable Object por red/job/partición que compacta
  duplicados, conserva una alarma sólo mientras hay trabajo y publica en su
  Queue. Payments sí declara un Cron cada minuto como **recovery sweep** de
  outbox y watchers activos; no reemplaza a Queue ni es el scheduler primario.
  El consumidor de Payments confirma sólo jobs completados: una reentrega con
  lease vigente se reprograma hasta que pueda reclamarlo.
- En Payments, únicamente `repositories/` y `stores/` acceden a `PAYMENTS_DB`.
  El rail on-chain encapsula Circle/RPC/routers para que casos de uso y
  persistencia no dependan de un proveedor concreto.
- `PAYMENT_LIVE_ENABLED=false` y el manifest sin routers mainnet mantienen
  claves, webhooks e intents live bloqueados por backend. El selector del
  Dashboard sólo refleja esa capacidad; nunca es el control de seguridad.
- Alchemy Address Activity entrega actividad de wallets y un Custom Webhook
  filtrado despierta `InvoicePaid`/recovery. Ambos se verifican por HMAC y sólo
  producen señales particionadas; el pool RPC vuelve a leer la evidencia
  canónica antes de cambiar journal, ledger o balances. Address Activity también
  solicita una reconciliación puntual y deduplicada para cubrir ETH nativo; la
  suscripción usa un espejo D1 incremental, no una lectura completa por cambio.
- Los límites de rango, prioridad y concurrencia pertenecen a la configuración
  de cada endpoint. `RpcAdmissionController` aplica el límite entre todas las
  instancias; no existe lógica de negocio dependiente de un plan gratuito.
- Address Activity es la vía rápida, no un punto único de fallo. Mientras
  existan wallets activas, `indexer_safety_sweep` conserva una única alarma
  global y, cada `INDEXER_SAFETY_SWEEP_SECONDS`, compara el head `safe` contra
  los checkpoints exactos. Sólo agenda shards atrasados y una reconciliación
  acotada de balances por shard; con cero wallets activas se desarma y no vuelve
  a ejecutarse. `GET /health` rearma la agenda para shards preexistentes después
  de un deploy, sin esperar a que un usuario abra Home.
- Invariante de reposo: sin wallets activas ni trabajo durable pendiente hay
  cero alarmas, mensajes de Queue, invocaciones background y lecturas RPC.
- Cada Worker persiste exclusivamente en su D1 y consume exclusivamente su Queue.

### 3. Contratos y Account Abstraction (ERC-4337)
- **`AccountWebAuthnV2.sol`:** wallet del usuario (MultiSigner ERC-7913 + ejecución ERC-7821 + UUPS). Múltiples passkeys, threshold y recovery con guardian + timelock 48h (propuestas validadas, cancelables por dueño y guardian).
- **`AccountFactoryV2.sol`:** despliega proxies hacia el implementation. `predictAddress`/`createAccount`.
- **`ParmeliaPaymaster.sol`:** implementación propia opcional de patrocinio. El adapter firma `paymasterAndData` por UserOp, acotado a `[validAfter, validUntil]` (~10 min). Cap on-chain de coste por op (`maxSponsoredGasCost`) y ciclo completo de stake. La cuenta no queda vinculada a este contrato.
- **`ParmeliaPaymentRouter.sol`:** rail abierto no-custodial (Flow B): cualquier wallet externa paga una invoice autorizada por firma del backend; fondos directo al merchant, fee al treasury (cap 1%).
- **`ParmeliaCrosschainRouter.sol`:** fee-skim + `depositForBurn` de CCTP v2 (outbound), cap 1%, `receiveMessage` permissionless en destino.
- **`ERC7913WebAuthnVerifier.sol`:** verificador stateless de firmas WebAuthn/P256.

El relayer es el EOA del servidor: paga el gas de `handleOps`. No puede mover fondos sin una firma válida del usuario.

### 4. Ciclo de vida de un pago (crash-safe)

`pending_payments.status`: `prepared → submitting → submitted → confirmed | failed`, cada transición con compare-and-set atómico (un doble submit recibe 409 `PAYMENT_IN_PROGRESS`).

- `/pay/prepare` construye la UserOp patrocinada y persiste la intención (`prepared`).
- `/pay/submit` reclama la fila (`submitting`), simula, difunde `handleOps`,
  registra el tx (`submitted`) y responde `202` sin mantener el request abierto
  esperando el receipt.
- El éxito lo decide el **`UserOperationEvent` del EntryPoint**, no `receipt.status` (una ejecución interna revertida mina igual el bundle con `success=false`).
- La contabilidad vive en **`services/settlement.ts`** y es **idempotente** (ledger con índice único de dedupe, link/intent por CAS, push solo si la fila se insertó en esa corrida).
- El **reconciliador dirigido por eventos** es el único que confirma el resultado: localiza
  la op on-chain por `userOpHash`, liquida o marca `failed`, y expira lo que ya
  no puede aterrizar (ventana del paymaster vencida). `GET
  /pay/status/:userOpHash` expone el estado para polling.

### 5. Ledger e Indexer (historial)
GatoPago **relaya** todas las operaciones de la app, así que las conoce al ocurrir. La tabla **`ledger`** es la única fuente de `/user/transactions`:
- Cada pago/swap/faucet escribe sus filas al confirmar (batch atómico); para transferencias internas se escriben **ambos lados** al instante.
- Lo único que la app no conoce al escribir son **depósitos externos**
  entrantes. Con Alchemy Address Activity, el proveedor empuja sólo actividad
  de wallets registradas. El registro incremental asigna wallets a shards
  estables y el evento despierta sólo token, dirección y shard afectados. Sin
  Notify —o si se perdió una entrega— el barrido autónomo despierta los shards
  atrasados desde su checkpoint aunque nadie abra la app. Home puede acelerar
  un bootstrap faltante, pero no es la garantía de descubrimiento. Los watchers
  usan evidencia `safe`/confirmaciones y journal idempotente antes de mover cada
  cursor. La cobertura de un token se calcula por wallet como el mínimo de sus
  streams `from`/`to`; no existe un checkpoint global ficticio.
- `/user/transactions` no toca RPC/explorer en cada request: lee solo D1.

### 6. Cross-chain (CCTP v2)
Diseño completo en [`docs/design/cross-chain.md`](./docs/design/cross-chain.md). Outbound: la op se registra en D1
**antes** de firmar el burn; esa transición despierta el relayer, que consulta
Iris sólo mientras haya una op en vuelo y se apaga al llegar a un estado
terminal. Antes de gastar gas valida el mensaje CCTP contra la op
(dominios/recipient/amount). Inbound: checkout público `/cc/:username`; el
pagador externo llama al TokenMessenger directamente y registra su tx (dedupe
único por hash).

### 7. API de cobros `/v1` + dashboard
`gatopago-payments-api` crea un intent y link juntos. El checkout emite quotes
de fee viva ligada al hash de una capability, exige `personal_sign` del payer y
reserva un solo attempt EIP-712. Un source hash sólo se persiste después de que
Payments verifica por RPC receipt, `from`, router y evento del attempt; el
watcher reconcilia evidencia aunque el navegador no registre el hash. Los
webhooks usan outbox atómico, entrega física at-least-once y dedupe lógica por
evento. Dashboard y checkout apuntan directamente a Payments; App mantiene un
proxy temporal para clientes N-1. Referencia pública en `docs/api.md` y
`docs/openapi.yaml`.

---

## Backend App (`server/`)

### Entry point
`server/src/index.ts` compone la API, exporta `{ fetch, queue }`,
`EventJobScheduler` y `RpcAdmissionController`:
- `cors()` (allowlist por `ALLOWED_ORIGINS`; abierto = warning en mainnet), `logger()`, `authMiddleware` globales; healthcheck `GET /`.
- Montaje propio: `/user/transactions`, `/user`, `/account`, `/pay`, `/crosschain`, `/swap`, `/contacts`, `/bridge`, Home/Earn/card. El control `legacy | frozen | payments` mantiene rollback, congela las superficies extraídas y sólo después delega `/links`, `/checkout`, `/v1` y `/merchant` por Service Binding, siempre sin acceso a `PAYMENTS_DB`. En `/pay`, el guard se aplica al link almacenado, no a las operaciones personales.
- `queue` transporta jobs de dominio compactados; los mensajes inválidos se
  confirman sin bloquear hermanos y los fallos usan retry con backoff.
- `EventJobScheduler` almacena como máximo una generación por
  job/partición, compacta productores equivalentes sin serializar shards
  independientes y elimina su alarma al quedar vacío.

### Servicios
- `clients.ts`, `rpcProviders.ts`, `rpcControlPlane.ts` y `rpcAdmission.ts`:
  pool viem por rol/capacidad, failover determinista, circuit breakers,
  concurrencia distribuida y atribución por lane, sin exponer URLs.
- `userOp.ts`: `buildSponsoredUserOp` (con guard de contratos desplegados), `encodeExecuteBatch` (ERC-7821), `serializeBigInts`, `normalizeLowS`.
- `paymaster.ts`: firma del sponsorship. `keys.ts`: **política de claves least-privilege** (fallbacks solo en testnet; mainnet exige claves dedicadas).
- `settlement.ts`: liquidación idempotente + `getUserOpResult` (parser del `UserOperationEvent`) + reconciliador dirigido por eventos.
- `storage.ts` es la fachada de acceso tipado a D1; `storage/` separa por dominio
  ledger, merchants/webhooks, passkeys, cross-chain, operaciones de cuenta,
  leases, cursores y features de usuario. Las transacciones y claims atómicos se
  mantienen dentro del módulo que posee cada estado.
- `eventScheduler.ts` / `eventJobs.ts`: agenda particionada con alarmas,
  compactación, dispatch por Queue, continuaciones basadas en D1 y recuperación.
- `indexerPartitions.ts` / `indexerShards.ts`: registro incremental de wallets,
  asignaciones estables y particiones por token/dirección/shard.
- `paymentRouter.ts`: autorización firmada de invoices (Flow B; permit condicionado por `paymentRouterHasPermit`).
- `crosschainRelayer.ts`: relayer CCTP (atestaciones Iris, mint en destino, validación de mensaje, gas-gating tri-estado fail-closed).
- `webhooks.ts`: outbox firmado (HMAC estilo Stripe) con claim + concurrencia limitada. `apiKeys.ts`: generación/verificación de claves `sk_`.
- `earn.ts`: Ahorro sobre Aave v3 (APY on-chain desde `currentLiquidityRate`, flags del reserve fail-closed, batches approve+supply / withdraw; el aToken en la cuenta del usuario es la única fuente de verdad — nada en D1).
- `validation.ts`, `swap.ts` + `uniswap.ts`, `bridge.ts` (Across legacy, solo cotización), `push.ts` (FCM HTTP v1, multi-dispositivo), `turnstile.ts` (fail-closed en mainnet), `indexer.ts` (núcleo de transferencias) + `indexer/` (watchers de router, recovery y ERC-4337), `apiError.ts`, `logger.ts`.

### Rutas API (resumen)

| Método | Ruta                        | Auth | Descripción                                                        |
| ------ | --------------------------- | ---- | ----------------------------------------------------------------- |
| GET    | `/`                         | NO   | Healthcheck                                                        |
| GET/PUT | `/user/*`                  | SÍ   | Perfil, username, balance, push-token, historial (ledger)         |
| GET    | `/user/:username`           | NO   | Resuelve username público                                          |
| POST   | `/auth/email-link/request`  | NO   | Solicita magic link Firebase (Turnstile + rate limits)              |
| POST   | `/auth/step-up/email-link/*`| SÍ   | Solicita/canjea challenge de enlace para recovery sensible          |
| POST   | `/account/create`           | SÍ   | Crea wallet V2 (Turnstile + rate limit por IP + referido + auto-fund con claim atómico) |
| GET/PUT/POST | `/account/passkey*`   | SÍ   | Estado de passkeys/recovery · calldata/UserOp `addSigners`        |
| GET/POST | `/account/fund`           | SÍ   | Faucet (Turnstile + rate limit por uid + claim atómico + receipt verificado) |
| POST   | `/account/recovery/*`       | SÍ   | propose / execute (guardian, timelock 48h, receipts verificados)  |
| POST/GET | `/links` · `/links/:id`   | SÍ/NO | Crear/listar links · datos públicos                              |
| POST   | `/pay/prepare` · `/pay/submit` | SÍ | Ciclo de vida completo (ver §4); re-chequeo de link/intent al preparar Y al enviar |
| GET    | `/pay/status/:userOpHash`   | SÍ   | Estado del pago para polling                                       |
| GET/POST | `/swap/*`                 | SÍ   | Whitelist · cotización on-chain · UserOp de swap                  |
| GET/POST | `/earn/{config,prepare}`  | SÍ   | Ahorro (Aave v3): APY vivo + saldos · UserOp de depósito/retiro (fail-closed por flags del reserve) |
| GET/POST/DELETE | `/contacts*`       | SÍ   | Contactos + código de referido + contador                         |
| GET/POST | `/bridge/*`               | SÍ   | Cotización Across (legacy, solo mainnet)                          |
| GET/POST | `/crosschain/{config,quote,prepare}` | SÍ | Outbound CCTP (op registrada antes de firmar; gas-gating fail-closed) |
| GET    | `/crosschain/status/:opId`  | SÍ   | Progreso outbound (burn → attestation → mint)                     |
| GET/POST | `/crosschain/inbound/*`   | NO   | Fondeo CCTP público de una cuenta (rate limit por IP; dedupe de tx; status por opId) |
| *      | `/v1/*`                     | sk_  | API pública de payment intents (ver `docs/api.md`)                |
| *      | `/merchant/*`               | SÍ   | Dashboard: keys, webhooks, pagos (paginación por cursor), sandbox |

---

## Modelo de Datos en D1

Migraciones en `server/migrations/` (aplicar SIEMPRE antes de desplegar el Worker que las usa):

- `0001_schema.sql` — base consolidada (`STRICT`, FKs, CHECKs). Su prólogo `DROP` es solo-testnet.
- `0002_api.sql` — merchants, api_keys, payment_intents, webhook_endpoints, events, webhook_deliveries.
- `0003_router.sql` — soporte Flow B. `0004_push_tokens.sql` — push multi-dispositivo.
- `0005_crosschain.sql` — crosschain_operations. `0006_hardening.sql` — rebuild STRICT/FK/CHECK de 0004-0005 + columnas de operabilidad del relayer + dedupe de burn tx + índices FK.
- `0007_payment_lifecycle.sql` — máquina de estados de pending_payments + rate_limits.
- `0008_earn.sql` — kind `'earn'` en el ledger (movimientos de Ahorro/Aave).
- `0009`–`0026` — perfil, integridad, operaciones durables de cuenta, journal,
  read models, evidencia de finality/reorg, shards, control RPC y outboxes.
- `0027_indexer_consistency.sql` — epoch chain-wide de reorg, guards atómicos y
  outbox durable para reproducir todos los streams afectados.
- `0028`–`0029` — interés de tarjeta y migración de marca.
- `0030_email_otp.sql` — códigos de correo con hash HMAC, expiración, intentos y
  consumo atómico; nunca almacena el código en claro.
- `0031_webauthn_registration.sql` — ceremonias de alta WebAuthn ligadas a
  challenge, usuario, RP y origen del servidor.
- `0032_recovery_step_up.sql` — proof de seguridad de un solo uso para recovery,
  límite de intentos de registro y vínculo UID de los códigos.

| Tabla              | Contenido                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `users`            | `uid` (PK), `username` (unique), `wallet_address` (unique, lowercase), `referral_code`, `credential_id`, `funded_at` (claim atómico del faucet), `invited_by` |
| `passkeys`         | `credential_id` (PK), `uid`, `qx`, `qy` → multi-passkey/recovery cross-device                          |
| `push_tokens`      | un token FCM por dispositivo (fan-out en `notifyUser`)                                                 |
| `payment_links`    | links de cobro; `status` solo transiciona `pending→paid` por CAS                                       |
| `pending_payments` | UserOps en vuelo: `status` (`prepared/submitting/submitted/confirmed/failed`), `submitted_tx_hash`, `user_op_json`, `meta`, TTL |
| `swap_quotes`      | cotización con TTL: par, montos, protocolo (v3/v4), pool, slippage, `status`                           |
| `contacts`         | contactos del usuario                                                                                   |
| `ledger`           | movimientos unificados (in/out × payment/link/swap/fund/external) con **índice único de dedupe**       |
| `sync_state`       | estado compatible heredado; los cursores canónicos viven en `chain_stream_checkpoints`                 |
| `merchants` / `api_keys` | comercio + claves `sk_` (solo hash)                                                              |
| `payment_intents`  | intents `/v1` (respaldados por payment_links; `onchain_id` para Flow B; `expires_at` aplicado)         |
| `webhook_endpoints` / `events` / `webhook_deliveries` | outbox firmado con reintentos/backoff y claim atómico            |
| `crosschain_operations` | operaciones CCTP personales de App (STRICT/FK/CHECK; relayer propio y dedupe de `source_tx_hash`); no se copian a Payments durante el cutover |
| `rate_limits`      | contadores de ventana fija del rate limiter in-Worker                                                   |
| `auth_email_codes` | códigos de acceso/step-up con digest HMAC, TTL, intentos y consumo atómico                              |
| `auth_step_up_sessions` | proofs opacos de un solo uso, ligados al UID y almacenados únicamente como HMAC                    |
| `webauthn_registration_challenges` | challenges de alta ligados al servidor; máximo cinco verificaciones                    |

---

## Frontend (`client/`)

### Ruteo y protección (`App.tsx`)

| Ruta          | Login | Wallet      | Componente      |
| ------------- | ----- | ----------- | --------------- |
| `/login` · `/onboarding` | NO/SÍ | -/sin wallet | `Login` · `Onboarding` |
| `/` `/charge` `/send` `/scan` `/swap` `/statement` `/contacts` `/deposit` `/receive` `/earn` `/deposit/binance` `/crosschain` `/settings` | SÍ | SÍ | páginas protegidas |
| `/pay`, `/pay/status`, `/:username` | NO | NO | flujo público de pago |
| `/cc/:recipient` | NO | NO | checkout público cross-chain (wallet externa vía `window.ethereum`) |

Todo está envuelto en `<ErrorBoundary>`. Páginas con `React.lazy`. Accesibilidad: `:focus-visible` global, modales con semántica de diálogo (`useDialog`: foco, Escape, `aria-modal`), inputs de monto con `AmountInput` (decimales con coma en iOS), navegación con `LinkButton` (`<Link>` real), `aria-live` en estados de pago.

### Capas transversales
- **`lib/api.ts`**: `apiFetch` tipado; lanza `ApiError` con `error_code` + `status` + `requestId`.
- **`lib/notify.ts`**: único lugar que habla con sileo; prefiere `t("err."+code)` sobre el texto del server.
- **`lib/format.ts`**: formatos de monto/fecha/hora con el locale activo de i18n.
- **`lib/transactions.ts`**: modelo + parsing del ledger + `txLabel`.
- **`components/ReceiptModal.tsx`**: comprobante (fecha, hora, N° = tx hash, respeta "ocultar saldo").

---

## WebAuthn y Passkeys

- Creación: `platform`, `residentKey: required`, `userVerification: required`, P256. El servidor emite el challenge y valida origen, RP ID, presencia y verificación de usuario, algoritmo ES256, attestation `none` y vínculo del credential ID. `qx`/`qy` se derivan de la clave COSE validada; los valores del cliente nunca son la autoridad.
- Firma: intenta `allowCredentials` con el `credentialId` conocido; si no, flujo discoverable. La cancelación del prompt NO reintenta automáticamente.
- Múltiples passkeys en la **misma dirección** vía `addSigners` (firmado como UserOp). `qx/qy` persistidos server-side (tabla `passkeys`) para resolución multi-dispositivo.
- Recuperación: un código de correo autenticado confirma por separado la propuesta y la ejecución; cada proof dura 10 minutos y se consume una sola vez. Después el guardian propone (`proposeRecovery`, timelock 48h, propuesta validada on-chain) y ejecuta `executeRecovery`. Propuesta, ejecución y cancelación generan un evento durable con alerta por correo y push. El guardian no mueve fondos ni firma pagos.

---

## Seguridad y Custodia

- El login autentica a la persona; **no firma pagos**. La autorización on-chain es la passkey; el servidor **no guarda** la clave privada.
- El EOA del servidor despliega cuentas, envía faucet, paga gas y llama `handleOps`; **no puede** mover fondos sin firma válida.
- **Política de claves (least privilege, `services/keys.ts`):** roles separados (relayer / paymaster signer / router signer). En testnet, una clave puede cubrir varios roles por fallback; **en mainnet los fallbacks están prohibidos** (falla cerrado).
- **Gates fail-closed en mainnet:** Turnstile obligatorio en create/fund; `TODO_DEPLOY` inoperable; gas-gating del relayer CCTP rechaza rutas no verificadas.
- **Anti-abuso:** Turnstile + rate limiter D1 (por IP en endpoints públicos, por uid en el faucet) + reglas de zona Cloudflare como capa fuerte al tener dominio.
- Todo error público lleva `error_code` estable (`shared/errors.ts`, ver [`docs/reference/error-codes.md`](./docs/reference/error-codes.md)); el cliente es dueño del texto (i18n).
- Firmas P256 normalizadas a low-s. Monedas y rutas de swap validadas server-side contra whitelist. CORS por allowlist.
- Secrets nunca se versionan en Git: producción usa `wrangler secret` y local
  usa archivos ignorados con plantillas vacías. Los archivos ignorados siguen
  estando dentro del checkout/OneDrive; su inventario y el P0 de extracción
  están en [`docs/operations/worker-variables.md`](./docs/operations/worker-variables.md).

---

## Variables de Entorno

### Cliente (`client/.env`, plantilla en `client/.env.example`)

| Variable                        | Descripción                                  |
| ------------------------------- | -------------------------------------------- |
| `VITE_FIREBASE_*`               | Config Firebase web (incl. `MEASUREMENT_ID`, `VAPID_KEY`) |
| `VITE_SERVER_URL` / `VITE_APP_URL` | URLs de backend / frontend                |
| `VITE_CHAIN_KEY`                | Red activa en la UI                          |
| `VITE_TURNSTILE_SITE_KEY`       | Site key Turnstile (pública)                 |

### Servidor (`server/wrangler.jsonc` + secrets; plantilla en `server/.dev.vars.example`)

| Variable                       | Tipo    | Descripción                                          |
| ------------------------------ | ------- | ---------------------------------------------------- |
| `FIREBASE_PROJECT_ID` / `CHAIN_KEY` / `ALLOWED_ORIGINS` / `APP_URL` | var | Identidad, red activa, CORS, URL de checkout |
| `RPC_URL`                      | secret  | Compatibilidad para despliegues antiguos             |
| `RPC_READ_URLS`                | secret  | Pool de lecturas puntuales/receipts                  |
| `RPC_WRITE_URLS`               | secret  | Simulación y broadcast                               |
| `RPC_INDEXER_URLS`             | secret  | Pool canónico `eth_getLogs`; admite límites distintos |
| `RPC_ARCHIVE_URLS`             | secret  | Backfill histórico aislado                           |
| `RPC_PROVIDER_CAPABILITIES`    | secret/config | ID, prioridad, rango y concurrencia por endpoint |
| `BUNDLER_RPC_URLS`             | secret  | ERC-4337 bundler compatible con EntryPoint v0.9      |
| `PRIVATE_KEY`                  | secret  | EOA relayer (`handleOps` y CCTP)                     |
| `FAUCET_PRIVATE_KEY`           | secret  | EOA con el presupuesto del faucet                    |
| `RECOVERY_GUARDIAN_PRIVATE_KEY` | secret | Guardian de recovery (obligatoria en mainnet)       |
| `PAYMASTER_SIGNER_PRIVATE_KEY` | secret  | Firma sponsorships (obligatoria en mainnet)          |
| `SPONSORSHIP_PROVIDER` / `SPONSORSHIP_FALLBACK_PROVIDER` | var | `parmelia`, `erc7677` o `self-funded`; fallback sólo pre-firma |
| `SPONSORSHIP_PAYMASTER_ADDRESS` | var | Override de contrato propio para rotación sin cambiar el manifest de cuentas |
| `PAYMASTER_SERVICE_URL` / `PAYMASTER_SERVICE_EXPECTED_PAYMASTER` | secret/var | Servicio ERC-7677 y pin obligatorio de contrato en mainnet |
| `SPONSORSHIP_HEALTH_CHECK_ENABLED` / `PAYMASTER_MIN_DEPOSIT_WEI` | var | Verifica bytecode, EntryPoint, signer, depósito y cap operativo |
| `PAYMENT_ROUTER_SIGNER_PRIVATE_KEY` | secret | Firma autorizaciones Flow B (obligatoria en mainnet) |
| `TURNSTILE_SECRET_KEY`         | secret  | Anti-abuso (testnet: opcional; mainnet: fail-closed) |
| `FCM_SERVICE_ACCOUNT`          | secret  | Service account JSON (1 línea); sin definir = sin push |
| `CCTP_RPC_URLS`                | secret  | Opcional: JSON chainId→RPC para destinos cross-chain |
| `GATOPAGO_FEES_ENABLED` / `GATOPAGO_SWAP_FEE_BPS` / `GATOPAGO_MAX_FEE_BPS` / `GATOPAGO_TREASURY_ADDRESS` / `GATOPAGO_CROSSCHAIN_FEE_BPS` | var | Fees de operaciones wallet (OFF por defecto; hard cap 1%). Checkout se configura solo en Payments. |
| `CROSSCHAIN_PAUSED` / `CROSSCHAIN_DISABLED_CHAINS` / `CROSSCHAIN_MIN_RELAYER_GAS_WEI` | var | Kill switch y flags cross-chain |
| `EARN_PAUSED`                  | var     | Kill switch del Ahorro (Aave)                        |
| `GATOPAGO_DB`                  | binding | Base D1 principal                                    |
| `EVENT_JOB_SCHEDULER`          | binding | Durable Object: agenda compactada y alarma sólo con trabajo |
| `RPC_ADMISSION`                | binding | Durable Object: concurrencia global por endpoint/lane |
| `SCHEDULED_JOBS_QUEUE`         | binding | Jobs de dominio; permanece vacía en reposo           |
| `INDEXER_SAFETY_SWEEP_SECONDS` | var     | Intervalo 60–86400 s del fallback autónomo; sólo vive con wallets activas |
| `ALCHEMY_WEBHOOK_*` / `ALCHEMY_ADDRESS_WEBHOOKS_JSON` | secret/var | Uno o varios slots Address Activity |
| `ALCHEMY_CUSTOM_WEBHOOK_*`     | secret/var | Eventos filtrados de router/recovery              |

Payments configura por separado `PAYMENT_FEE_POLICY_JSON`,
`PAYMENT_PLATFORM_FEE_RECIPIENT` y
`PAYMENT_ROUTER_PREFLIGHT_ENABLED`. Ninguna pertenece al App Worker.

---

## Estado Actual

- Backend modularizado; config de red/tokens/Uniswap/CCTP unificada y portable; contrato de errores estable con i18n.
- Pagos con ciclo de vida crash-safe (claim atómico, `UserOperationEvent` como verdad, liquidación idempotente, reconciliador dirigido por eventos, `GET /pay/status`).
- Cuentas V2: múltiples passkeys en la misma dirección + recovery endurecido con guardian/timelock.
- Swaps internos (v3/v4), cross-chain CCTP v2 (outbound e inbound, código completo), contactos + referidos, extracto con filtros en URL, comprobantes, i18n ES/EN.
- API de cobros `/v1` (test mode) + dashboard de comerciantes con webhooks firmados.
- Historial servido desde el `ledger` (D1) + ingestión push/backfill bajo demanda; sin RPC por tab ni dependencia obligatoria de un indexador pago.
- Login Google/correo, Turnstile, push FCM multi-dispositivo y analytics — feature-flagged (fail-closed en mainnet donde aplica).
- Pendiente para producción: consultar el único [roadmap técnico](./docs/roadmap.md) y exigir evidencia fechada antes de cerrar cada gate.

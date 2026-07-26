# Parmelia - Arquitectura del Proyecto

> Actualizado: julio 2026. Complementos: `CLAUDE_REVIEW_FABLE.md` (auditoría y
> estado), `CROSSCHAIN_DESIGN.md` (cross-chain), `docs/api.md` (API pública `/v1`),
> `contracts/AUDIT.md` (contratos), `DEPLOY.md` (runbook).

## Resumen

**Parmelia** es una web app de pagos cripto sobre **Account Abstraction (ERC-4337, EntryPoint v0.9)**. La red activa es **Arbitrum** (Sepolia para testnet, One para producción), elegida por su soporte de **RIP-7212** (verificación P256/passkey barata, ~3,450 gas) y su gas bajo. El código es **portable**: cambiar de cadena es agregar una entrada de configuración y desplegar los contratos.

El producto combina:

- **Firebase Auth** para identidad: **Google** y **enlace mágico por correo** (passwordless). Apple se descartó por decisión.
- **Passkeys WebAuthn (P256)** para firmar operaciones de la wallet en el dispositivo.
- **Smart accounts `AccountWebAuthnV2`** (MultiSigner ERC-7913 + UUPS + recovery con guardian) desplegadas por factory.
- **Cloudflare Worker + D1** para API, orquestación de pagos, persistencia y relaying de UserOperations.

Funcionalidades de producto: links de cobro, pago a username/QR/manual, **swaps internos** (Uniswap v3/v4 vía Universal Router), **cross-chain USDC vía Circle CCTP v2** (enviar a otra red desde la app + checkout público `/cc/:username` para cobrar desde otras redes), **contactos e invitaciones con código de referido**, **extracto con filtros compartibles por URL**, **comprobantes**, **notificaciones push** ("te pagaron"), **i18n ES/EN**, y una **API de cobros `/v1` estilo Stripe** (payment intents, webhooks firmados, sandbox) con su **dashboard de comerciantes**.

El backend prepara y transmite UserOperations, pero **no custodia la clave de firma del usuario**. La autorización real de pagos ocurre con WebAuthn en el navegador.

---

## Stack Tecnológico

| Capa      | Tecnología                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Contratos | Solidity (solc pineado `0.8.28`), Foundry, OpenZeppelin v5 (ERC-7913 / ERC-7821 / UUPS)                                             |
| Cliente   | React 19, TypeScript 5.9, Vite 7, Tailwind CSS v4, react-i18next, Firebase (Auth + Messaging + Analytics), SWR, react-router-dom, qrcode.react, jsqr (lazy), html-to-image, sileo, Turnstile |
| Dashboard | React 19, Vite, SWR (`useSWRInfinite` para paginación), Firebase Auth — panel del comerciante para la API `/v1`                     |
| Servidor  | Hono, Cloudflare Workers + Queues + Durable Objects, viem, jose, **Cloudflare D1 (SQLite)**                                        |
| Shared    | Módulo TypeScript compartido: ABIs, redes/direcciones, tokens, config Uniswap/CCTP y **contrato de errores** (`errors.ts`)          |
| Red       | Arbitrum Sepolia (421614) - testnet activa. Arbitrum One (42161) - producción (contratos aún no desplegados). Base Sepolia - destino CCTP / legacy. |
| Deploy    | Cliente y dashboard en Vercel, servidor en Cloudflare Workers                                                                        |

---

## Estructura del Monorepo

```text
parmelia-links/
├── ARCHITECTURE.md / DEPLOY.md / CROSSCHAIN_DESIGN.md / DEFI_DESIGN.md / API_DESIGN.md
├── MEJORAS_PENDIENTES.md / CLAUDE_REVIEW_FABLE.md / ERROR_CODES.md / INTEGRACIONES.md
├── docs/                    # referencia pública de la API /v1 (api.md + openapi.yaml)
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
├── server/                  # Cloudflare Worker (Hono)
│   ├── migrations/               # 0001..0007 (ver "Modelo de Datos")
│   └── src/
│       ├── index.ts              # middlewares + rutas + consumers de Queue
│       ├── chain.ts              # chainKey -> viem Chain
│       ├── middlewares/          # auth.ts (Firebase JWKS), apiAuth.ts (API keys sk_)
│       ├── routes/               # user, account, links, pay, transactions, swap, contacts,
│       │                         #   bridge, crosschain, v1 (API pública), merchant (dashboard)
│       └── services/             # storage(D1), settlement (liquidación+reconciliador), userOp,
│                                 #   paymaster, paymentRouter, crosschainRelayer, clients, keys,
│                                 #   validation, swap, uniswap, bridge, push, turnstile, indexer,
│                                 #   eventScheduler, eventJobs, webhooks, apiKeys, apiError, logger
├── contracts/               # Foundry (V2 activo)
│   ├── src/                      # AccountWebAuthnV2, AccountFactoryV2, ParmeliaPaymaster,
│   │                             #   ParmeliaPaymentRouter, ParmeliaCrosschainRouter, ERC7913WebAuthnVerifier
│   ├── storage-layout/           # snapshots del layout (gate manual pre-upgrade, AUDIT M-3)
│   └── script/Deploy.s.sol       # deploy determinista CREATE2
└── shared/
    ├── index.ts                  # ABIs (compiladas) + erc20Abi
    ├── errors.ts                 # contrato de errores: ERR + ERROR_HTTP_STATUS (ver ERROR_CODES.md)
    └── networks.ts               # fuente de verdad: redes, tokens, Uniswap, CCTP, direcciones, guards
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
| Verifier (Arb Sepolia)  | `0xb7fA10dEe75042D6973676A7d7882e4621B806d6` (V2)               |
| Factory (Arb Sepolia)   | `0x75c7761dcED5F8eCc708E750bDe5CA7d4557EDEB` (V2)               |
| Paymaster (Arb Sepolia) | `0x31f357a64cF5899da21337f0D9e28ef8D6385753` (V2)               |
| PaymentRouter (Arb Sepolia) | `0x607fF0c2eE5E4ae9a7bD2F7E343ea53a1992975A` (Flow B; sin `payInvoiceWithPermit` hasta redeploy) |
| CrosschainRouter (Arb Sepolia) | `0x0816d13337C3A7a03Df639F40993e88B771dD777` (CCTP outbound) |
| Contratos (Arb One)     | _TODO: desplegar V2 y rellenar `shared/networks.ts`_            |

Por el deploy determinista (CREATE2 con salt fijo + solc pineado), los contratos obtienen la **misma dirección en toda cadena** si el bytecode es idéntico → cada usuario conserva **la misma dirección de wallet** entre cadenas. Nota: las fuentes de los contratos avanzaron respecto de lo desplegado (permit del router, validación de recovery, caps y stake del paymaster) — esos endurecimientos rigen tras el próximo redeploy; ver `contracts/AUDIT.md`.

---

## Arquitectura Lógica

### 1. Cliente (React/Vite)
- Sesión vía Firebase: Google o enlace mágico por correo.
- Onboarding obligatorio cuando hay login pero aún no hay wallet; verificación **Turnstile** antes de crear cuenta.
- Crea passkeys (`createPasskey`) y firma UserOps (`signWithPasskey`).
- Consume la API con la capa tipada **`lib/api.ts`** (`apiFetch` → `ApiError` con `error_code`) y centraliza avisos en **`lib/notify.ts`** (mapea `error_code → t("err."+code)`).
- Push opt-in (`lib/push.ts`), eventos de funnel (`lib/analytics.ts`), PWA instalable, i18n ES/EN.

### 2. Worker API (Hono/Cloudflare)
- Verifica Firebase ID tokens con JWKS de Google (cache 1h); la superficie `/v1` autentica con API keys `sk_` (hash SHA-256 en D1).
- API de usuario, cuenta, links, pagos, swaps, contactos, cross-chain, historial (ledger), API pública `/v1` y rutas del dashboard (`/merchant`).
- Despliega smart accounts; construye UserOps ERC-4337 patrocinadas y las envía con `handleOps`.
- No existe Cron Trigger. Las transiciones de dominio y los webhooks firmados
  registran trabajo en `EventJobScheduler`: un Durable Object independiente por
  red, job y partición. Cada objeto compacta duplicados de su shard, conserva
  una alarma sólo mientras tiene trabajo y publica en Queue. El consumidor usa
  un lease D1 y se reprograma sólo si aún existe estado activo.
- Alchemy Address Activity entrega actividad de wallets y un Custom Webhook
  filtrado despierta `InvoicePaid`/recovery. Ambos se verifican por HMAC y sólo
  producen señales particionadas; el pool RPC vuelve a leer la evidencia
  canónica antes de cambiar journal, ledger o balances. Address Activity también
  solicita una reconciliación puntual y deduplicada para cubrir ETH nativo; la
  suscripción usa un espejo D1 incremental, no una lectura completa por cambio.
- Los límites de rango, prioridad y concurrencia pertenecen a la configuración
  de cada endpoint. `RpcAdmissionController` aplica el límite entre todas las
  instancias; no existe lógica de negocio dependiente de un plan gratuito.
- Invariante de reposo: agenda vacía implica cero alarmas, mensajes de Queue,
  invocaciones background y lecturas RPC.
- Persiste todo en D1.

### 3. Contratos y Account Abstraction (ERC-4337)
- **`AccountWebAuthnV2.sol`:** wallet del usuario (MultiSigner ERC-7913 + ejecución ERC-7821 + UUPS). Múltiples passkeys, threshold y recovery con guardian + timelock 48h (propuestas validadas, cancelables por dueño y guardian).
- **`AccountFactoryV2.sol`:** despliega proxies hacia el implementation. `predictAddress`/`createAccount`.
- **`ParmeliaPaymaster.sol`:** patrocina gas. El servidor firma `paymasterAndData` por UserOp, acotado a `[validAfter, validUntil]` (~10 min). Cap on-chain de coste por op (`maxSponsoredGasCost`) y ciclo completo de stake. `postOp` es el punto de integración para fees.
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
Parmelia **relaya** todas las operaciones de la app, así que las conoce al ocurrir. La tabla **`ledger`** es la única fuente de `/user/transactions`:
- Cada pago/swap/faucet escribe sus filas al confirmar (batch atómico); para transferencias internas se escriben **ambos lados** al instante.
- Lo único que la app no conoce al escribir son **depósitos externos**
  entrantes. Con Alchemy Address Activity, el proveedor empuja sólo actividad
  de wallets registradas. El registro incremental asigna wallets a shards
  estables y el evento despierta sólo token, dirección y shard afectados. Sin
  Notify —o si se perdió una entrega— un Home stale despierta esas mismas
  particiones y la reconciliación puntual desde su checkpoint; si nadie abre la
  app, no existe fallback. Los watchers usan evidencia
  `safe`/confirmaciones y journal idempotente antes de mover cada cursor.
- `/user/transactions` no toca RPC/explorer en cada request: lee solo D1.

### 6. Cross-chain (CCTP v2)
Diseño completo en `CROSSCHAIN_DESIGN.md`. Outbound: la op se registra en D1
**antes** de firmar el burn; esa transición despierta el relayer, que consulta
Iris sólo mientras haya una op en vuelo y se apaga al llegar a un estado
terminal. Antes de gastar gas valida el mensaje CCTP contra la op
(dominios/recipient/amount). Inbound: checkout público `/cc/:username`; el
pagador externo llama al TokenMessenger directamente y registra su tx (dedupe
único por hash).

### 7. API de cobros `/v1` + dashboard
Payment intents estilo Stripe respaldados por payment links (Flow A) o pagables on-chain por cualquier wallet vía PaymentRouter (Flow B, reconciliado por el watcher de `InvoicePaid`). Webhooks firmados HMAC-SHA256 con outbox en D1, claim atómico anti doble-entrega, reintentos con backoff (1m→24h, 6 intentos) y reenvío manual desde el dashboard. `expires_at` se aplica en pago, autorización on-chain y simulate. Referencia pública en `docs/api.md` + `docs/openapi.yaml`.

---

## Backend (`server/`)

### Entry point
`server/src/index.ts` compone la API, exporta `{ fetch, queue }`,
`EventJobScheduler` y `RpcAdmissionController`:
- `cors()` (allowlist por `ALLOWED_ORIGINS`; abierto = warning en mainnet), `logger()`, `authMiddleware` globales; healthcheck `GET /`.
- Montaje: `/user/transactions`, `/user`, `/account`, `/links`, `/pay`, `/swap`, `/contacts`, `/bridge`, `/crosschain`, `/v1`, `/merchant`.
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
- `storage.ts`: acceso tipado a D1 (todas las tablas) + claims atómicos (faucet, submit, webhooks, leases) + productores de jobs + rate limiter de ventana fija.
- `eventScheduler.ts` / `eventJobs.ts`: agenda particionada con alarmas,
  compactación, dispatch por Queue, continuaciones basadas en D1 y recuperación.
- `indexerPartitions.ts` / `indexerShards.ts`: registro incremental de wallets,
  asignaciones estables y particiones por token/dirección/shard.
- `paymentRouter.ts`: autorización firmada de invoices (Flow B; permit condicionado por `paymentRouterHasPermit`).
- `crosschainRelayer.ts`: relayer CCTP (atestaciones Iris, mint en destino, validación de mensaje, gas-gating tri-estado fail-closed).
- `webhooks.ts`: outbox firmado (HMAC estilo Stripe) con claim + concurrencia limitada. `apiKeys.ts`: generación/verificación de claves `sk_`.
- `earn.ts`: Ahorro sobre Aave v3 (APY on-chain desde `currentLiquidityRate`, flags del reserve fail-closed, batches approve+supply / withdraw; el aToken en la cuenta del usuario es la única fuente de verdad — nada en D1).
- `validation.ts`, `swap.ts` + `uniswap.ts`, `bridge.ts` (Across legacy, solo cotización), `push.ts` (FCM HTTP v1, multi-dispositivo), `turnstile.ts` (fail-closed en mainnet), `indexer.ts` (3 watchers), `apiError.ts`, `logger.ts`.

### Rutas API (resumen)

| Método | Ruta                        | Auth | Descripción                                                        |
| ------ | --------------------------- | ---- | ----------------------------------------------------------------- |
| GET    | `/`                         | NO   | Healthcheck                                                        |
| GET/PUT | `/user/*`                  | SÍ   | Perfil, username, balance, push-token, historial (ledger)         |
| GET    | `/user/:username`           | NO   | Resuelve username público                                          |
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
| GET/POST | `/crosschain/inbound/*`   | NO   | Checkout público (rate limit por IP; dedupe de tx; status por opId) |
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
| `crosschain_operations` | ops CCTP (STRICT/FK/CHECK; `attempt_count`, `last_error`, dedupe único de `source_tx_hash`)       |
| `rate_limits`      | contadores de ventana fija del rate limiter in-Worker                                                   |

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

- Creación: `platform`, `residentKey: required`, `userVerification: required`, P256. `createPasskey(userId, label)` usa el `uid` estable como id de credencial y muestra email/nombre en el diálogo del SO. Se extraen `qx`/`qy`.
- Firma: intenta `allowCredentials` con el `credentialId` conocido; si no, flujo discoverable. La cancelación del prompt NO reintenta automáticamente.
- Múltiples passkeys en la **misma dirección** vía `addSigners` (firmado como UserOp). `qx/qy` persistidos server-side (tabla `passkeys`) para resolución multi-dispositivo.
- Recuperación: guardian (EOA del servidor) propone (`proposeRecovery`, timelock 48h, propuesta validada on-chain) y luego `executeRecovery`. El dueño puede cancelar (alertado por push vía watcher); el guardian también puede cancelar su propia propuesta. El guardian no mueve fondos ni firma pagos.

---

## Seguridad y Custodia

- El login autentica a la persona; **no firma pagos**. La autorización on-chain es la passkey; el servidor **no guarda** la clave privada.
- El EOA del servidor despliega cuentas, envía faucet, paga gas y llama `handleOps`; **no puede** mover fondos sin firma válida.
- **Política de claves (least privilege, `services/keys.ts`):** roles separados (relayer / paymaster signer / router signer). En testnet, una clave puede cubrir varios roles por fallback; **en mainnet los fallbacks están prohibidos** (falla cerrado).
- **Gates fail-closed en mainnet:** Turnstile obligatorio en create/fund; `TODO_DEPLOY` inoperable; gas-gating del relayer CCTP rechaza rutas no verificadas.
- **Anti-abuso:** Turnstile + rate limiter D1 (por IP en endpoints públicos, por uid en el faucet) + reglas de zona Cloudflare como capa fuerte al tener dominio.
- Todo error público lleva `error_code` estable (`shared/errors.ts`, ver `ERROR_CODES.md`); el cliente es dueño del texto (i18n).
- Firmas P256 normalizadas a low-s. Monedas y rutas de swap validadas server-side contra whitelist. CORS por allowlist.
- Secrets nunca en el repo: van por `wrangler secret` / `.dev.vars` (gitignored; plantilla en `.dev.vars.example`).

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
| `PAYMENT_ROUTER_SIGNER_PRIVATE_KEY` | secret | Firma autorizaciones Flow B (obligatoria en mainnet) |
| `TURNSTILE_SECRET_KEY`         | secret  | Anti-abuso (testnet: opcional; mainnet: fail-closed) |
| `FCM_SERVICE_ACCOUNT`          | secret  | Service account JSON (1 línea); sin definir = sin push |
| `CCTP_RPC_URLS`                | secret  | Opcional: JSON chainId→RPC para destinos cross-chain |
| `PARMELIA_FEES_ENABLED` / `PARMELIA_SWAP_FEE_BPS` / `PARMELIA_MAX_FEE_BPS` / `PARMELIA_TREASURY_ADDRESS` / `PARMELIA_PAYMENT_FEE_BPS` / `PARMELIA_CROSSCHAIN_FEE_BPS` | var | Fees (OFF por defecto; hard cap 1% en código y contratos) |
| `CROSSCHAIN_PAUSED` / `CROSSCHAIN_DISABLED_CHAINS` / `CROSSCHAIN_MIN_RELAYER_GAS_WEI` | var | Kill switch y flags cross-chain |
| `EARN_PAUSED`                  | var     | Kill switch del Ahorro (Aave)                        |
| `PARMELIA_DB`                  | binding | Base D1 principal                                    |
| `EVENT_JOB_SCHEDULER`          | binding | Durable Object: agenda compactada y alarma sólo con trabajo |
| `RPC_ADMISSION`                | binding | Durable Object: concurrencia global por endpoint/lane |
| `SCHEDULED_JOBS_QUEUE`         | binding | Jobs de dominio; permanece vacía en reposo           |
| `ALCHEMY_WEBHOOK_*` / `ALCHEMY_ADDRESS_WEBHOOKS_JSON` | secret/var | Uno o varios slots Address Activity |
| `ALCHEMY_CUSTOM_WEBHOOK_*`     | secret/var | Eventos filtrados de router/recovery              |

---

## Estado Actual

- Backend modularizado; config de red/tokens/Uniswap/CCTP unificada y portable; contrato de errores estable con i18n.
- Pagos con ciclo de vida crash-safe (claim atómico, `UserOperationEvent` como verdad, liquidación idempotente, reconciliador dirigido por eventos, `GET /pay/status`).
- Cuentas V2: múltiples passkeys en la misma dirección + recovery endurecido con guardian/timelock.
- Swaps internos (v3/v4), cross-chain CCTP v2 (outbound e inbound, código completo), contactos + referidos, extracto con filtros en URL, comprobantes, i18n ES/EN.
- API de cobros `/v1` (test mode) + dashboard de comerciantes con webhooks firmados.
- Historial servido desde el `ledger` (D1) + ingestión push/backfill bajo demanda; sin RPC por tab ni dependencia obligatoria de un indexador pago.
- Login Google/correo, Turnstile, push FCM multi-dispositivo y analytics — feature-flagged (fail-closed en mainnet donde aplica).
- Pendiente para producción: ver la lista de gates y acciones del operador en `CLAUDE_REVIEW_FABLE.md` §8 y `MEJORAS_PENDIENTES.md`.

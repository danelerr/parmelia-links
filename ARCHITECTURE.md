# Parmelia - Arquitectura del Proyecto

## Resumen

**Parmelia** es una web app de pagos cripto sobre **Account Abstraction (ERC-4337, EntryPoint v0.9)**. La red activa es **Arbitrum** (Sepolia para testnet, One para producción), elegida por su soporte de **RIP-7212** (verificación P256/passkey barata, ~3,450 gas) y su gas bajo. El código es **portable**: cambiar de cadena es agregar una entrada de configuración y desplegar los contratos.

El producto combina:

- **Firebase Auth** para identidad: **Google**, **Apple** (tras flag) y **enlace mágico por correo** (passwordless).
- **Passkeys WebAuthn (P256)** para firmar operaciones de la wallet en el dispositivo.
- **Smart accounts `AccountWebAuthnV2`** (MultiSigner ERC-7913 + UUPS + recovery con guardian) desplegadas por factory.
- **Cloudflare Worker + D1** para API, orquestación de pagos, persistencia y relaying de UserOperations.

Funcionalidades de producto: links de cobro, pago a username/QR/manual, **swaps internos** (Uniswap v3/v4 vía Universal Router), **depósitos cross-chain** (Across, MVP), **contactos e invitaciones con código de referido**, **extracto con filtros**, **comprobantes**, y **notificaciones push** ("te pagaron").

El backend prepara y transmite UserOperations, pero **no custodia la clave de firma del usuario**. La autorización real de pagos ocurre con WebAuthn en el navegador.

---

## Stack Tecnológico

| Capa      | Tecnología                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Contratos | Solidity ^0.8.27, Foundry, OpenZeppelin v5 (ERC-7913 / ERC-7821 / UUPS)                                                            |
| Cliente   | React 19, TypeScript 5.9, Vite 7, Tailwind CSS v4, Firebase (Auth + Messaging + Analytics), SWR, react-router-dom, qrcode.react, jsqr, html-to-image, sileo, Turnstile |
| Servidor  | Hono, Cloudflare Workers (+ Cron Triggers), viem, jose, **Cloudflare D1 (SQLite)**                                                 |
| Shared    | Módulo TypeScript compartido para ABIs, tokens, config de Uniswap y redes/direcciones                                              |
| Red       | Arbitrum Sepolia (421614) - testnet activa. Arbitrum One (42161) - producción. Base Sepolia - legacy.                              |
| Deploy    | Cliente en Vercel, servidor en Cloudflare Workers                                                                                  |

---

## Estructura del Monorepo

```text
parmelia-links/
├── ARCHITECTURE.md / DEPLOY.md / INTEGRACIONES.md / DEFI_DESIGN.md / MEJORAS_PENDIENTES.md / EVALUACION_TECNICA.md
├── package.json / pnpm-workspace.yaml
├── client/                  # SPA React (Vercel build desde esta carpeta)
│   ├── public/
│   │   ├── sw.js                 # service worker (PWA shell + FCM push)
│   │   └── manifest.webmanifest
│   └── src/
│       ├── App.tsx               # ruteo + protección + init analytics
│       ├── main.tsx              # registro del service worker (solo prod)
│       ├── components/           # Logo, ReceiptModal, Turnstile, ErrorBoundary, ...
│       ├── hooks/                # useNav (view transitions)
│       ├── lib/                  # api, notify, firebase, push, analytics, webauthn,
│       │                         #   authFetch, activeNetwork, networks, transactions, exportCard, hex
│       └── pages/                # Login, Onboarding, Home, CreateLink, PayPage, PaymentStatus,
│                                 #   ScanQR, Swap, Statement, Contacts, Deposit, Settings
├── server/                  # Cloudflare Worker (Hono)
│   ├── migrations/               # 0001_schema.sql (esquema consolidado)
│   └── src/
│       ├── index.ts              # composición: middlewares + rutas + handler `scheduled` (cron)
│       ├── chain.ts              # chainKey -> viem Chain
│       ├── middlewares/auth.ts   # Bindings, JWKS de Firebase, requireAuth
│       ├── routes/               # user, account, links, pay, transactions, swap, contacts, bridge
│       └── services/             # storage(D1), userOp, paymaster, clients, validation,
│                                 #   swap, uniswap, bridge, push, turnstile, indexer, logger
├── contracts/               # Foundry (V2 activo)
│   ├── src/                      # AccountWebAuthnV2, AccountFactoryV2, ParmeliaPaymaster, ERC7913WebAuthnVerifier
│   └── script/Deploy.s.sol       # deploy determinista CREATE2
└── shared/
    ├── index.ts                  # ABIs (compiladas) + erc20Abi
    └── networks.ts               # fuente de verdad: redes, tokens (whitelist), config Uniswap, direcciones
```

---

## Portabilidad entre cadenas

Toda la configuración dependiente de la red vive en **`shared/networks.ts`**. No hay direcciones ni cadenas hardcodeadas en los handlers: el servidor resuelve todo con `getNetworkConfig(env.CHAIN_KEY)`.

Cada red declara `contracts: { entryPoint, factory, paymaster, verifier, usdc, usdcDecimals }`, su lista de `tokens` whitelisted (USDC/ETH/WBTC), su `uniswap` (Universal Router, Permit2, quoters, PoolManager) y metadata (explorer, faucet).

Para agregar una cadena:

1. Desplegar los contratos V2 (factory, paymaster, verifier) con el script determinista.
2. Agregar una entrada en `NETWORKS` de `shared/networks.ts` (direcciones + tokens + uniswap + metadata).
3. Mapear la cadena a su `viem.Chain` en `server/src/chain.ts` (`CHAIN_MAP`).
4. Reflejar la metadata de presentación (incluida `currencies`) en `client/src/lib/networks.ts`.
5. Apuntar `CHAIN_KEY` (var del Worker) y `VITE_CHAIN_KEY` (cliente) a la nueva clave.

El cliente nunca necesita direcciones de contrato: todo el trabajo on-chain pasa por el servidor. `client/src/lib/networks.ts` solo replica los campos de presentación (nombre, símbolo, explorer, faucet, monedas) porque Vercel construye desde `client/` y no puede importar `../shared`.

### Direcciones por red

El EntryPoint, USDC y la infra de Uniswap son fijos; verifier/factory/paymaster se rellenan tras desplegar.

| Contrato                | Valor                                                          |
| ----------------------- | -------------------------------------------------------------- |
| EntryPoint (v0.9)       | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` (canónico, igual en toda cadena) |
| USDC (Arbitrum One)     | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` (native Circle)    |
| USDC (Arbitrum Sepolia) | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` (Circle testnet)   |
| WBTC (Arbitrum One)     | `0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f` (8 dec)            |
| Verifier (Arb Sepolia)  | `0xb7fA10dEe75042D6973676A7d7882e4621B806d6` (V2)               |
| Factory (Arb Sepolia)   | `0x75c7761dcED5F8eCc708E750bDe5CA7d4557EDEB` (V2)               |
| Paymaster (Arb Sepolia) | `0x31f357a64cF5899da21337f0D9e28ef8D6385753` (V2)               |
| Verifier / Factory / Paymaster (Arb One) | _TODO: desplegar V2 y rellenar `shared/networks.ts`_   |

Por el deploy determinista (CREATE2 con salt fijo), verifier/impl/factory/paymaster obtienen la **misma dirección en toda cadena** si el bytecode es idéntico → cada usuario conserva **la misma dirección de wallet** entre cadenas. Base Sepolia queda como legacy (corrió los V1 de un solo signer).

---

## Arquitectura Lógica

### 1. Cliente (React/Vite)
- Sesión vía Firebase: Google, Apple (flag) o enlace mágico por correo.
- Onboarding obligatorio cuando hay login pero aún no hay wallet; verificación **Turnstile** antes de crear cuenta.
- Crea passkeys (`createPasskey`) y firma UserOps (`signWithPasskey`).
- Consume la API con la capa tipada **`lib/api.ts`** (`apiFetch` → `ApiError`) y centraliza avisos en **`lib/notify.ts`**.
- Push opt-in (`lib/push.ts`), eventos de funnel (`lib/analytics.ts`), PWA instalable.

### 2. Worker API (Hono/Cloudflare)
- Verifica Firebase ID tokens con JWKS de Google (cache 1h).
- API de usuario, cuenta, links, pagos, swaps, contactos, bridge e historial (ledger).
- Despliega smart accounts; construye UserOps ERC-4337 patrocinadas y las envía con `handleOps`.
- **Cron Trigger** (cada 2 min) ejecuta el `indexer` que ingiere depósitos externos al ledger.
- Persiste todo en D1.

### 3. Contratos y Account Abstraction (ERC-4337)
- **`AccountWebAuthnV2.sol`:** wallet del usuario (MultiSigner ERC-7913 + ejecución ERC-7821 + UUPS). Múltiples passkeys, threshold y recovery con guardian + timelock.
- **`AccountFactoryV2.sol`:** despliega proxies hacia el implementation. `predictAddress`/`createAccount`.
- **`ParmeliaPaymaster.sol`:** patrocina gas. El servidor firma `paymasterAndData` por UserOp, acotado a `[validAfter, validUntil]` (~10 min). `postOp` es el punto de integración para fees.
- **`ERC7913WebAuthnVerifier.sol`:** verificador stateless de firmas WebAuthn/P256.

El relayer es el EOA del servidor: paga el gas de `handleOps`. No puede mover fondos sin una firma válida del usuario.

### 4. Ledger e Indexer (historial)
Parmelia **relaya** todas las operaciones de la app, así que las conoce al ocurrir. La tabla **`ledger`** es la única fuente de `/user/transactions`:
- Cada pago/swap/faucet escribe sus filas al confirmar; para transferencias internas se escriben **ambos lados** (out del pagador, in del receptor) al instante.
- Lo único que la app no ve son **depósitos externos** entrantes: el **cron indexer** (`services/indexer.ts`) escanea logs `Transfer` ERC-20 hacia las wallets de usuarios desde un cursor (`sync_state`) y los ingiere como `kind="external"`. Escrituras idempotentes (índice único).
- `/user/transactions` ya **no toca RPC/explorer** en cada request: lee solo D1.

---

## Backend (`server/`)

### Entry point
`server/src/index.ts` compone la API y exporta `{ fetch, scheduled }`:
- `cors()` (allowlist por `ALLOWED_ORIGINS`), `logger()`, `authMiddleware` globales; healthcheck `GET /`.
- Montaje: `/user/transactions`, `/user`, `/account`, `/links`, `/pay`, `/swap`, `/contacts`, `/bridge`.
- `scheduled` (cron) → `runIndexer(env)` vía `ctx.waitUntil`.

### Servicios
- `clients.ts`: clients viem + `waitForTx` (tuneado para Arbitrum).
- `userOp.ts`: `buildSponsoredUserOp`, `encodeExecuteBatch` (ERC-7821), `serializeBigInts`, `normalizeLowS`.
- `paymaster.ts`: firma del sponsorship.
- `storage.ts`: acceso tipado a D1 (users, links, pending, passkeys, swap_quotes, contactos, ledger, sync_state).
- `validation.ts`: normalizadores (monto, wallet, currency por whitelist).
- `swap.ts` + `uniswap.ts`: cotización on-chain (QuoterV2 + V4Quoter) y encoding del Universal Router.
- `bridge.ts`: cotización cross-chain vía API pública de Across.
- `push.ts`: FCM HTTP v1 (OAuth2 service-account con jose). Feature-flag.
- `turnstile.ts`: verificación anti-abuso. Feature-flag.
- `indexer.ts`: cron indexer de depósitos externos.
- `logger.ts`: logging JSON con `requestId`.

### Rutas API (resumen)

| Método | Ruta                        | Auth | Descripción                                                        |
| ------ | --------------------------- | ---- | ----------------------------------------------------------------- |
| GET    | `/`                         | NO   | Healthcheck                                                        |
| GET    | `/user/profile`             | SÍ   | Perfil (`uid`, `walletAddress`, `username`)                        |
| PUT    | `/user/username`            | SÍ   | Username único (regex + lista reservada que cubre rutas reales)   |
| GET    | `/user/balance`             | SÍ   | Balance de todos los tokens whitelisted                           |
| PUT    | `/user/push-token`          | SÍ   | Registra/borra el token FCM del dispositivo                       |
| GET    | `/user/:username`           | NO   | Resuelve username público                                          |
| GET    | `/user/transactions`        | SÍ   | Historial desde el `ledger` (sent/received con `kind`)            |
| POST   | `/account/create`           | SÍ   | Crea wallet V2 (+ Turnstile, referido, auto-fund 5 USDC)          |
| GET/PUT| `/account/passkey`          | SÍ   | Estado de passkeys/recovery · calldata `addSigners`              |
| POST   | `/account/passkey/prepare`  | SÍ   | UserOp de `addSigners`                                             |
| GET/POST| `/account/fund`            | SÍ   | Estado / canje del faucet (+ Turnstile)                           |
| POST   | `/account/recovery/*`       | SÍ   | propose / execute (guardian, timelock 48h)                        |
| POST/GET| `/links` · `/links/:id`    | SÍ/NO| Crear/listar links · datos públicos                              |
| POST   | `/pay/prepare` · `/pay/submit` | SÍ | UserOp patrocinada → firma WebAuthn → `handleOps` + ledger + push |
| GET/POST| `/swap/tokens` · `/swap/quote` · `/swap/prepare` | SÍ | Whitelist · cotización on-chain · UserOp de swap |
| GET/POST/DELETE | `/contacts` · `/contacts/invites` | SÍ | Contactos + código de referido + contador |
| GET/POST| `/bridge/config` · `/bridge/quote` | SÍ | Redes soportadas · cotización de puente (Across) |

Notas:
- `/pay/submit` normaliza `s` a low-s (OZ P256), envuelve la firma multi-signer, simula y envía `handleOps`, escribe el ledger (ambos lados si es interno) y dispara el push al receptor. Acciones que no son pago (`PASSKEY_ADD`, `SWAP`) reusan el pipeline sin registrarse como transferencia.
- El gas de `handleOps` se deriva del propio UserOp almacenado (los swaps usan más `callGasLimit`).

---

## Modelo de Datos en D1

Esquema en `server/migrations/0001_schema.sql` (consolidado; `STRICT`, FKs `ON DELETE CASCADE`).

| Tabla              | Contenido                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| `users`            | `uid` (PK), `username` (unique), `wallet_address` (unique, lowercase), `referral_code` (unique), `credential_id`, `funded_at`, `invited_by`, `push_token`, timestamps |
| `passkeys`         | `credential_id` (PK), `uid`, `qx`, `qy`, timestamps                                                  |
| `payment_links`    | `id` (PK), `owner_uid`, `wallet_address`, `amount`, `currency`, `status`, `tx_hash`, `paid_*`        |
| `pending_payments` | `user_op_hash` (PK), `uid`, `link_id`, `sender_address`, `user_op_json`, `meta` (JSON), `expires_at`  |
| `swap_quotes`      | cotización con TTL: par, montos, protocolo (v3/v4), pool, slippage, `status` (quoted/prepared/executed/expired) |
| `contacts`         | `id` (PK), `owner_uid`, `contact_uid`, `username`, `wallet_address`, `alias`                          |
| `ledger`           | movimientos unificados: `direction` (in/out), `kind` (payment/link/swap/fund/external), `tx_hash`, `token`, `amount`, contraparte, `created_at` |
| `sync_state`       | cursor de bloque del cron indexer                                                                     |

- `wallet_address` se guarda en minúsculas para el lookup inverso (dirección → usuario) que alimenta el ledger.
- `pending_payments` se limpia por `expires_at` (TTL ~10 min) en cada `prepare`.
- El esquema de testnet es desechable: `0001_schema.sql` incluye un prólogo `DROP` que lo hace seguro de aplicar sobre una DB previa.

---

## Frontend (`client/`)

### Ruteo y protección (`App.tsx`)

| Ruta          | Login | Wallet      | Componente      |
| ------------- | ----- | ----------- | --------------- |
| `/login`      | NO    | NO          | `Login`         |
| `/onboarding` | SÍ    | sin wallet  | `Onboarding`    |
| `/`           | SÍ    | SÍ          | `Home`          |
| `/charge`     | SÍ    | SÍ          | `CreateLink`    |
| `/send`       | SÍ    | SÍ          | `PayPage`       |
| `/scan`       | SÍ    | SÍ          | `ScanQR`        |
| `/swap`       | SÍ    | SÍ          | `Swap`          |
| `/statement`  | SÍ    | SÍ          | `Statement`     |
| `/contacts`   | SÍ    | SÍ          | `Contacts`      |
| `/deposit`    | SÍ    | SÍ          | `Deposit`       |
| `/settings`   | SÍ    | SÍ          | `Settings`      |
| `/pay`, `/pay/status`, `/:username` | NO | NO | flujo público de pago |

Todo está envuelto en `<ErrorBoundary>` (pantalla de recuperación de marca ante errores de render o chunks rotos). Páginas con `React.lazy`. Las rutas de la app están en inglés; la página pública de pago vive en `/:username`.

### Capas transversales
- **`lib/api.ts`**: `apiFetch` tipado; lanza `ApiError` con mensaje humano + `status` + `requestId`. Única fuente de `SERVER_URL`.
- **`lib/notify.ts`**: único lugar que habla con sileo. Humaniza errores técnicos, trata la cancelación de passkey como aviso (no error rojo), agrega `Ref:` (requestId) y deduplica toasts.
- **`lib/transactions.ts`**: modelo + parsing del ledger + `txLabel`.
- **`components/ReceiptModal.tsx`**: comprobante (fecha, hora, N° = tx hash, link al explorador).

---

## WebAuthn y Passkeys

- Creación: `platform`, `residentKey: required`, `userVerification: required`, P256. `createPasskey(userId, label)` usa el `uid` estable como id de credencial y muestra email/nombre en el diálogo del SO. Se extraen `qx`/`qy`.
- Firma: intenta `allowCredentials` con el `credentialId` conocido; si no, flujo discoverable.
- Múltiples passkeys en la **misma dirección** vía `addSigners` (firmado como UserOp).
- Las passkeys viven en el gestor del SO (Google Password Manager / Llavero de iCloud), independiente del método de login.
- Recuperación: guardian (EOA del servidor) propone (`proposeRecovery`, timelock 48h) y luego `executeRecovery`. El guardian no mueve fondos ni firma pagos.

---

## Notificaciones, anti-abuso y analytics

- **Push (FCM):** opt-in en Ajustes; `lib/push.ts` registra el token, el `sw.js` maneja `push`/`notificationclick`. El Worker envía via FCM HTTP v1 al pagar (interno) y al ingerir un depósito externo. Best-effort (nunca bloquea un pago). iOS solo con PWA instalada.
- **Turnstile:** verificación invisible (Managed) en crear cuenta y faucet. Feature-flag por `TURNSTILE_SECRET_KEY`.
- **Analytics (GA4):** eventos de funnel (`wallet_created`, `link_created`, `payment_sent`, `swap_completed`, `invite_shared`). Dormido hasta configurar `VITE_FIREBASE_MEASUREMENT_ID`.

---

## Seguridad y Custodia

- El login autentica a la persona; **no firma pagos**. La autorización on-chain es la passkey; el servidor **no guarda** la clave privada.
- El EOA del servidor despliega cuentas, envía faucet, paga gas y llama `handleOps`; **no puede** mover fondos sin firma válida.
- Firmas P256 normalizadas a low-s. Usernames validados (regex + reservados que cubren todas las rutas). Monedas y rutas de swap validadas server-side contra whitelist.
- CORS por allowlist; la autorización real es token Firebase + signer WebAuthn.
- Secrets nunca en el repo: service account y claves van por `wrangler secret` / `.dev.vars` (gitignored).

---

## Variables de Entorno

### Cliente (`client/.env`, plantilla en `client/.env.example`)

| Variable                        | Descripción                                  |
| ------------------------------- | -------------------------------------------- |
| `VITE_FIREBASE_*`               | Config Firebase web (incl. `MEASUREMENT_ID`) |
| `VITE_SERVER_URL` / `VITE_APP_URL` | URLs de backend / frontend                |
| `VITE_CHAIN_KEY`                | Red activa en la UI                          |
| `VITE_TURNSTILE_SITE_KEY`       | Site key Turnstile (pública)                 |
| `VITE_FIREBASE_VAPID_KEY`       | VAPID pública para web push                  |
| `VITE_ENABLE_APPLE_LOGIN`       | `"true"` para mostrar el botón de Apple      |

### Servidor (`server/wrangler.jsonc` + secrets)

| Variable                       | Tipo    | Descripción                                          |
| ------------------------------ | ------- | --------------------------------------------------- |
| `FIREBASE_PROJECT_ID`          | var     | Proyecto Firebase (valida ID tokens)                |
| `CHAIN_KEY`                    | var     | Red activa (`arbitrum-sepolia` / `arbitrum-one`)    |
| `ALLOWED_ORIGINS`             | var     | Allowlist CORS separada por comas                   |
| `RPC_URL`                      | secret  | RPC (acepta varias URLs por coma → failover)        |
| `PRIVATE_KEY`                  | secret  | EOA del Worker (deploy, faucet, guardian, relayer)  |
| `PAYMASTER_SIGNER_PRIVATE_KEY` | secret  | EOA que firma el sponsorship del paymaster          |
| `TURNSTILE_SECRET_KEY`         | secret  | Verificación Turnstile (sin definir = se omite)     |
| `FCM_SERVICE_ACCOUNT`          | secret  | Service account JSON (1 línea); sin definir = sin push |
| `PARMELIA_FEES_ENABLED` / `PARMELIA_SWAP_FEE_BPS` / `PARMELIA_MAX_FEE_BPS` / `PARMELIA_TREASURY_ADDRESS` | var | Fees de swap (OFF por defecto; hard cap 1%) |
| `PARMELIA_CROSSCHAIN_FEE_BPS`  | var     | Spread de retiro cross-chain (cap 1%)               |
| `PARMELIA_DB`                  | binding | Base D1 principal                                   |
| (cron)                         | trigger | `*/2 * * * *` → indexer de depósitos externos       |

---

## Estado Actual

- Backend modularizado; config de red/tokens/Uniswap unificada y portable en `shared/networks.ts`.
- Pagos en dos pasos (`prepare` → WebAuthn → `submit`); UserOps patrocinadas centralizadas.
- Cuentas V2: múltiples passkeys en la misma dirección + recovery con guardian/timelock.
- Swaps internos (v3/v4), depósitos cross-chain (MVP Across), contactos + referidos, extracto con filtros, comprobantes.
- Historial servido desde el `ledger` (D1) + cron indexer; sin dependencia de indexador pago.
- Login multi-método (Google/Apple/correo), Turnstile, push FCM y analytics - todos feature-flagged.
- Pendiente para producción: desplegar contratos V2 en Arbitrum y rellenar direcciones (ver `DEPLOY.md`).

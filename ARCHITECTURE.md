# Parmelia Links - Arquitectura del Proyecto

## Resumen

**Parmelia Links** es una web app de links de cobro y pagos cripto sobre **Account Abstraction (ERC-4337, EntryPoint v0.9)**. La red activa es **Arbitrum** (Sepolia para testnet, One para producción), elegida por su soporte de **RIP-7212** (verificación P256/passkey barata, ~3,450 gas) y su gas bajo. El código es **portable**: cambiar de cadena es agregar una entrada de configuración y desplegar los contratos.

El producto combina cuatro piezas principales:

- **Firebase Auth + Google login** para identidad dentro de la app.
- **Passkeys WebAuthn (P256)** para firmar operaciones de la wallet en el dispositivo.
- **Smart accounts `AccountWebAuthnV2`** (MultiSigner + UUPS + recovery con guardian) desplegadas por factory.
- **Cloudflare Worker + D1** para API, orquestacion de pagos, persistencia y relaying de UserOperations.

El backend prepara y transmite UserOperations, pero **no custodia la clave privada de firma del usuario**. La autorizacion real de pagos ocurre con WebAuthn en el navegador del usuario.

---

## Stack Tecnologico

| Capa      | Tecnologia                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Contratos | Solidity 0.8.27, Foundry, OpenZeppelin v5 (ERC-7913 / ERC-7821)                                                                  |
| Cliente   | React 19, TypeScript 5.9, Vite 7, Tailwind CSS v4, Firebase Auth, SWR, react-router-dom, qrcode.react, jsqr, html-to-image, sileo |
| Servidor  | Hono, Cloudflare Workers, viem, jose, **Cloudflare D1 (SQLite)**                                                                 |
| Shared    | Modulo TypeScript compartido para ABIs y configuracion de redes/direcciones                                                       |
| Red       | Arbitrum Sepolia (421614) — testnet activa. Arbitrum One (42161) — producción. Base Sepolia — legacy.                              |
| Deploy    | Cliente en Vercel, servidor en Cloudflare Workers                                                                                 |

---

## Estructura del Monorepo

```text
parmelia-links/
├── ARCHITECTURE.md
├── package.json
├── pnpm-workspace.yaml
├── client/                  # SPA React (Vercel build desde esta carpeta)
│   └── src/
│       ├── App.tsx
│       ├── authFetch.ts
│       ├── firebase.ts
│       ├── network.ts        # red activa derivada de env vars
│       ├── networks.ts       # mirror de presentacion de shared/networks.ts
│       ├── webauthn.ts
│       ├── components/
│       └── pages/
├── server/                  # Cloudflare Worker (Hono)
│   └── src/
│       ├── index.ts          # composicion: middlewares + montaje de rutas
│       ├── chain.ts          # chainKey -> viem Chain
│       ├── middlewares/auth.ts
│       ├── routes/           # user, account, links, pay, transactions
│       └── services/         # storage (D1), history, paymaster, clients, userOp, logger
├── contracts/               # Foundry (V2 activo, V1 legacy)
│   ├── src/
│   └── script/
└── shared/
    ├── index.ts             # ABIs (compiladas) + erc20Abi
    └── networks.ts          # fuente de verdad: redes + direcciones por red
```

---

## Portabilidad entre cadenas

Toda la configuracion dependiente de la red vive en **`shared/networks.ts`**. No hay direcciones ni cadenas hardcodeadas en los handlers: el servidor resuelve todo con `getNetworkConfig(env.CHAIN_KEY)`.

Cada red declara `contracts: { entryPoint, factory, paymaster, verifier, usdc, usdcDecimals }` ademas de su metadata (explorer, faucet, provider de historial).

Para agregar una nueva cadena (ej. Arbitrum / Avalanche):

1. Desplegar los contratos V2 (factory, paymaster, verifier) en la nueva red.
2. Agregar una entrada en `NETWORKS` de `shared/networks.ts` con sus direcciones y metadata.
3. Mapear la cadena a su `viem.Chain` en `server/src/chain.ts` (`CHAIN_MAP`).
4. Si la UI debe mostrar esa red, reflejar su metadata de presentacion en `client/src/networks.ts`.
5. Apuntar `CHAIN_KEY` (var del Worker) a la nueva clave.

El cliente nunca necesita direcciones de contrato: todo el trabajo on-chain pasa por el servidor. Por eso `client/src/networks.ts` solo replica los campos de presentacion (nombre, simbolo, explorer, faucet). Es un archivo aparte porque Vercel construye el cliente desde `client/` y no puede importar `../shared`.

### Direcciones por red

El EntryPoint y USDC son fijos; el resto se rellena tras desplegar (deploy determinista en `contracts/script/Deploy.s.sol`).

| Contrato                | Arbitrum (todas)                                                |
| ----------------------- | -------------------------------------------------------------- |
| EntryPoint (v0.9)       | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` (canónico, igual en toda cadena) |
| USDC (Arbitrum One)     | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` (native Circle)    |
| USDC (Arbitrum Sepolia) | _TODO: confirmar en Circle docs_                               |
| Verifier / Factory / Paymaster | _TODO: desplegar V2 con el script determinista y rellenar `shared/networks.ts`_ |

Gracias al deploy determinista (CREATE2 con salt fijo vía el deployer `0x4e59...`), verifier/impl/factory/paymaster obtienen la **misma dirección en toda cadena** si el bytecode es idéntico — y por tanto cada usuario conserva **la misma dirección de wallet** entre cadenas. Eso vuelve trivial migrar de cadena. Base Sepolia queda como red legacy (corrió los contratos V1 de un solo signer).

---

## Arquitectura Logica

### 1. Cliente (React/Vite)

- Gestiona sesion con Google via Firebase.
- Fuerza onboarding cuando el usuario ya inicio sesion pero aun no tiene wallet.
- Crea passkeys (`createPasskey`) y firma UserOps (`signWithPasskey`).
- Consume la API del Worker con `fetchWithAuth` (adjunta el ID token y reintenta una vez ante 401).
- Muestra balance, historial, links de cobro, QR y ajustes de cuenta.

### 2. Worker API (Hono/Cloudflare)

- Verifica Firebase ID tokens con JWKS de Google (cache de 1h).
- Expone la API de usuario, cuenta, links, pagos e historial.
- Despliega smart accounts a partir de la clave publica WebAuthn.
- Prepara UserOperations ERC-4337 patrocinadas por el paymaster y las envia con `handleOps`.
- Persiste estado de la app en D1 (perfiles, links, pending ops, historial enviado).

### 3. Contratos y Account Abstraction (ERC-4337)

- **`AccountWebAuthnV2.sol`:** wallet del usuario (MultiSigner ERC-7913 + ejecucion ERC-7821 + UUPS). Soporta multiples passkeys, threshold y recovery con guardian + timelock. Existe un solo despliegue "implementation" en cadena.
- **`AccountFactoryV2.sol`:** despliega clones (proxies) que apuntan al implementation, ahorrando gas. `predictAddress(initCallData)` calcula la direccion determinista; `createAccount(initCallData)` la despliega.
- **`ParmeliaPaymaster.sol`:** patrocina el gas. El servidor firma un `paymasterAndData` por cada UserOp, acotado a una ventana `[validAfter, validUntil]` (≈10 min, igual al TTL de `pending_payments`) para que una firma sin enviar no se pueda reusar. El `EntryPoint` consulta al paymaster y aplica la ventana. El `postOp` es no-op hoy (gas gratis) y es el punto de integración para un fee futuro.
- **`ERC7913WebAuthnVerifier.sol`:** verificador stateless de firmas WebAuthn/P256 referenciado por los signers (`abi.encodePacked(verifier, qx, qy)`).

El **Bundler/relayer** es el EOA del servidor: paga el gas real de la tx `handleOps`. No puede mover fondos de la smart account sin una firma valida del usuario.

### 4. Cloudflare D1

Base SQLite (binding `PARMELIA_DB`) usada para perfiles, usernames, links de cobro, operaciones pendientes (entre `prepare` y `submit`), historial de envios y control del faucet.

---

## Backend (`server/`)

### Entry point y middlewares

`server/src/index.ts` solo compone la API:

- `cors()` global (origin `*`; la autorizacion real depende del token Firebase + firma WebAuthn)
- `logger()` global
- `authMiddleware` global (deja `c.set("user", user | null)`)
- healthcheck `GET /`
- montaje de rutas: `/user/transactions`, `/user`, `/account`, `/links`, `/pay`
- `onError` global que loguea y responde `500` con `requestId`

`server/src/middlewares/auth.ts` define `Bindings`/`AppContext`, el cache de JWKS, `authMiddleware` y `requireAuth` (corta con `401`). El binding D1 usa el tipo global `D1Database` (de `worker-configuration.d.ts`).

### Servicios compartidos

- `services/clients.ts`: `getPublicClient`, `getWalletClient`, `getServerAccount`, `getClients` para la cadena activa.
- `services/userOp.ts`: `serializeBigInts` y `buildSponsoredUserOp` (nonce + gas + `paymasterAndData` firmado + `userOpHash`). Centraliza la construccion de UserOps para `/pay/prepare` y `/account/passkey/prepare`.
- `services/paymaster.ts`: firma del sponsorship del paymaster.
- `services/storage.ts`: acceso tipado a D1.
- `services/history.ts`: reconstruccion de historial on-chain (blockscout / monadscan / RPC, segun la red).
- `services/logger.ts`: logging estructurado en JSON con `requestId`.

### Rutas API

| Metodo | Ruta                       | Auth | Descripcion                                                                 |
| ------ | -------------------------- | ---- | --------------------------------------------------------------------------- |
| GET    | `/`                        | NO   | Healthcheck                                                                  |
| GET    | `/user/profile`            | SI   | Perfil actual (`uid`, `walletAddress`, `username`)                           |
| PUT    | `/user/username`           | SI   | Define username unico (validado con regex + lista reservada)                |
| GET    | `/user/balance`            | SI   | Balance on-chain del token nativo y USDC                                     |
| GET    | `/user/:username`          | NO   | Resuelve username publico a `walletAddress`                                  |
| GET    | `/user/transactions`       | SI   | Historial: enviados + cobrados por link + transferencias on-chain, dedup    |
| POST   | `/account/create`          | SI   | Crea la smart wallet V2 y auto-fund best-effort de 5 USDC                    |
| GET    | `/account/passkey`         | SI   | Estado de passkeys/recovery: signerCount, threshold, guardian, recovery     |
| PUT    | `/account/passkey`         | SI   | Devuelve el calldata `addSigners` para agregar una passkey (misma direccion)|
| POST   | `/account/passkey/prepare` | SI   | Construye la UserOp de `addSigners` y devuelve `userOpHash`                  |
| POST   | `/account/fund`            | SI   | Envia 5 USDC de prueba una sola vez                                          |
| GET    | `/account/fund`            | SI   | Consulta si el faucet ya fue canjeado                                        |
| POST   | `/account/recovery/propose`| SI   | Guardian propone recovery (timelock 48h)                                     |
| POST   | `/account/recovery/execute`| SI   | Ejecuta el recovery cuando vence el timelock                                 |
| POST   | `/links`                   | SI   | Crea un link de cobro `pending`                                              |
| GET    | `/links`                   | SI   | Lista links del usuario (hasta 20)                                           |
| GET    | `/links/:id`               | NO   | Datos publicos de un link                                                    |
| POST   | `/pay/prepare`             | SI   | Construye una UserOp patrocinada sin firma, valida balance, devuelve hash   |
| POST   | `/pay/submit`              | SI   | Recibe la assertion WebAuthn, normaliza la firma P256 y llama `handleOps`    |

Notas del flujo de pago:

- `POST /pay/prepare` guarda `pending_payments[userOpHash]` para enlazar la firma biometrica con la UserOp exacta.
- `POST /pay/submit` normaliza `s` a low-s (OpenZeppelin P256), envuelve la firma multi-signer, simula y envia `handleOps`, registra el envio y marca el link como `paid` cuando aplica.
- El mismo `userOpHash`/`/pay/submit` reusa el flujo para agregar passkeys (`currency: "PASSKEY_ADD"`), sin registrarlo como transferencia.

> El flujo legacy de "migracion V1 -> V2" y el endpoint destructivo `reset-wallet` fueron eliminados: en una cadena con despliegue V2 (Monad y cualquier red nueva) no existen wallets legacy, y la recuperacion segura se hace via `recovery/propose` + `recovery/execute`.

---

## Modelo de Datos en D1

Schema en `server/migrations/0001_initial.sql` (tablas `STRICT`, FKs con `ON DELETE CASCADE`).

| Tabla              | Contenido                                                                                   |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `users`            | `uid` (PK), `username` (unique), `wallet_address`, `credential_id`, `funded_at`, timestamps |
| `payment_links`    | link de cobro: `id` (PK), `owner_uid`, `wallet_address`, `amount`, `currency`, `status`, `tx_hash`, `paid_*` |
| `pending_payments` | `user_op_hash` (PK), `uid`, `link_id`, `sender_address`, `user_op_json`, `expires_at`        |
| `sent_transactions`| historial de envios propios: `uid` + `tx_hash` unique, `amount`, `currency`, `to_wallet`     |

- `credential_id` es una **pista de UX** para seleccionar la passkey correcta, no la fuente de verdad. La autoridad criptografica real es la clave publica P256 registrada on-chain.
- `pending_payments` se limpia por `expires_at` (TTL ~10 min) en cada `prepare`.

---

## Frontend (`client/`)

### Ruteo y proteccion (`App.tsx`)

| Ruta          | Login | Wallet      | Componente      |
| ------------- | ----- | ----------- | --------------- |
| `/login`      | NO    | NO          | `Login`         |
| `/onboarding` | SI    | sin wallet  | `Onboarding`    |
| `/`           | SI    | SI          | `Home`          |
| `/cobrar`     | SI    | SI          | `CreateLink`    |
| `/pagar`      | SI    | SI          | `PayPage`       |
| `/scan`       | SI    | SI          | `ScanQR`        |
| `/settings`   | SI    | SI          | `Settings`      |
| `/pay`        | NO    | NO          | `PayPage`       |
| `/pay/status` | NO    | NO          | `PaymentStatus` |
| `/:username`  | NO    | NO          | `PayPage`       |

`network.ts` deriva la red activa de `VITE_CHAIN_KEY` (+ overrides opcionales) sobre los defaults de `networks.ts`.

### Paginas

- **`Onboarding`**: crea la passkey y la wallet (`POST /account/create`).
- **`Home`**: SWR para perfil/balance/historial; mezcla enviados y recibidos en una linea de tiempo; comprobante PNG.
- **`CreateLink`**: links de cobro + QR + compartir.
- **`PayPage`**: pago de link, a username o manual. Flujo `prepare -> signWithPasskey -> submit`.
- **`PaymentStatus`**: comprobante de exito.
- **`ScanQR`**: escaneo de QR con camara (jsqr), navegacion solo si la URL es del mismo origen.
- **`Settings`**: perfil, username, wallet, passkeys (agregar passkey en la misma direccion), estado de recovery y faucet.

---

## WebAuthn y Gestion de Passkeys

- Creacion (`webauthn.ts`): `platform`, `residentKey: required`, `userVerification: required`, ES256/P256. Se extraen `qx`/`qy` (clave publica que valida el contrato).
- Firma (`signWithPasskey`): si hay `credentialId` conocido lo intenta primero con `allowCredentials` (evita mezclar passkeys de otras cuentas sincronizadas); si no, flujo discoverable.
- Multiples passkeys en la **misma direccion** via `addSigners` (V2): se prepara el calldata en `PUT /account/passkey`, se firma como UserOp y se envia por `/pay/submit`.
- Recuperacion: el guardian (EOA del servidor) propone un nuevo signer con `proposeRecovery` (timelock 48h) y luego `executeRecovery`. El guardian **no** puede mover fondos ni firmar pagos.

---

## Seguridad y Modelo de Custodia

- El login con Google autentica a la persona; **no firma pagos por si solo**.
- La autorizacion on-chain ocurre con la passkey WebAuthn del usuario; el servidor **no guarda** su clave privada.
- El EOA del servidor puede desplegar cuentas, enviar el faucet, pagar gas/bundling y llamar `handleOps`; **no puede** mover fondos sin una firma valida que el contrato acepte.
- Las firmas P256 se normalizan a low-s para OpenZeppelin.
- Los usernames se validan server-side (regex + reservados).
- CORS abierto (`*`), pero la autorizacion real depende del token Firebase y del signer WebAuthn.

---

## Variables de Entorno

### Cliente (`client/.env`)

| Variable                    | Descripcion              |
| --------------------------- | ------------------------ |
| `VITE_FIREBASE_*`           | Config de Firebase web   |
| `VITE_SERVER_URL`           | URL del backend          |
| `VITE_APP_URL`              | URL publica del frontend |
| `VITE_CHAIN_KEY`            | Red activa en la UI      |

`client/.env` esta en `.gitignore`; usar `client/.env.example` como plantilla.

### Servidor (`server/wrangler.jsonc` + secrets)

| Variable                       | Tipo    | Descripcion                                       |
| ------------------------------ | ------- | ------------------------------------------------- |
| `FIREBASE_PROJECT_ID`          | var     | Proyecto Firebase para validar ID tokens          |
| `CHAIN_KEY`                    | var     | Red activa (`monad-testnet`, ...)                 |
| `ALLOWED_ORIGINS`             | var     | (Opcional) Allowlist CORS separada por comas. Sin definir = cualquier origen |
| `RPC_URL`                      | secret  | RPC de la red activa (acepta varias URLs separadas por coma → failover)      |
| `PRIVATE_KEY`                  | secret  | EOA del Worker (deploy, faucet, guardian, relayer)|
| `PAYMASTER_SIGNER_PRIVATE_KEY` | secret  | EOA que firma el sponsorship del paymaster        |
| `PARMELIA_DB`                  | binding | Base D1 principal                                 |

---

## Estado Actual

- Backend modularizado (middlewares + rutas + servicios).
- Configuracion de red y direcciones unificada y portable en `shared/networks.ts`.
- Construccion de UserOps patrocinadas centralizada en `services/userOp.ts`.
- Onboarding obligatorio para usuarios autenticados sin wallet.
- Home basado en SWR; historial reconstruido on-chain + enriquecido con datos de D1.
- Flujo de pago en dos pasos (`prepare` -> firma WebAuthn -> `submit`).
- Cuentas V2: multiples passkeys en la misma direccion + recovery con guardian/timelock.

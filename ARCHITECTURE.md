# Parmelia Links - Arquitectura del Proyecto

## Resumen

**Parmelia Links** es una plataforma de links de pago cripto sobre **Account Abstraction (ERC-4337)** en **Base Sepolia**.

- Login con Google (Firebase Auth)
- Smart wallet por usuario con `AccountWebAuthn`
- Firma de pagos con **passkey WebAuthn (P256)** en el dispositivo (huella/FaceID)
- Links de cobro con QR y pagos directos por `/:username`
- Escaneo de QR con camara del dispositivo (`jsqr`)
- Historial de transacciones con links a block explorer

El backend construye y transmite UserOperations, pero **no custodia la clave privada de firma del usuario**.

---

## Stack Tecnologico

| Capa | Tecnologia |
|------|------------|
| Contratos | Solidity 0.8.27, Foundry, OpenZeppelin v5 |
| Cliente | React 19, TypeScript, Vite, Tailwind CSS v4, Firebase Auth, react-router-dom, qrcode.react, jsqr, html-to-image, sileo (toasts) |
| Servidor | Hono, Cloudflare Workers, viem, jose, Cloudflare KV |
| Shared | Modulo TypeScript compartido (ABIs, direcciones, constantes) |
| Red | Base Sepolia (84532) |
| Deploy | Cliente en Vercel, Servidor en Cloudflare Workers |

---

## Estructura del Monorepo

```text
parmelia-links/
├── ARCHITECTURE.md
├── package.json
├── pnpm-workspace.yaml
├── client/
│   ├── vercel.json              # SPA rewrites (todas las rutas -> index.html)
│   ├── vite.config.ts
│   ├── index.html
│   ├── src/
│   │   ├── App.tsx              # Router principal, auth state
│   │   ├── App.css
│   │   ├── index.css            # Tailwind theme (@theme con colores Parmelia)
│   │   ├── main.tsx
│   │   ├── firebase.ts          # Firebase Auth (Google login)
│   │   ├── webauthn.ts          # createPasskey + signWithPasskey
│   │   ├── authFetch.ts         # Wrapper fetch con Firebase token
│   │   ├── utils.ts
│   │   ├── components/
│   │   │   └── Logo.tsx         # SVG inline del logo Parmelia
│   │   └── pages/
│   │       ├── Login.tsx
│   │       ├── Home.tsx         # Dashboard: balance, transacciones, menu QR
│   │       ├── CreateLink.tsx   # Crear link de cobro + QR
│   │       ├── PayPage.tsx      # Pagar link/username/manual
│   │       ├── PaymentStatus.tsx # Comprobante de pago
│   │       ├── ScanQR.tsx       # Escaner QR con camara
│   │       └── Settings.tsx     # Username, wallet, passkey, faucet USDC
├── server/
│   ├── src/
│   │   └── index.ts             # API completa (Hono)
│   ├── wrangler.jsonc
│   └── iniciar.sh
├── contracts/
│   ├── src/
│   │   ├── AccountWebAuthn.sol
│   │   ├── AccountFactory.sol
│   │   └── ParmeliaPaymaster.sol
│   ├── script/
│   │   └── Deploy.s.sol
│   └── lib/
│       ├── forge-std/
│       └── openzeppelin-contracts/
├── shared/
│   ├── index.ts                 # ABIs, direcciones, constantes
│   └── EntrypointV08.ts
└── pantallas/
```

---

## Direcciones (Base Sepolia)

| Contrato | Direccion |
|----------|-----------|
| AccountWebAuthn (implementation) | `0xae77c3f3db27f688431372b41cfcddd4916386f0` |
| AccountFactory | `0x8c91e55b11287c9c3970b64602fe50763fac0345` |
| EntryPoint V09 | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` |
| Paymaster | `0xa1DC7ad6f4d2d0ea20bF5668F132c38c4f3c172D` |
| USDC (Base Sepolia) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

---

## Shared (`shared/`)

`shared/index.ts` exporta:

- ABIs: `accountWebAuthnAbi`, `accountFactoryAbi`, `entryPointAbi`, `erc20Abi`
- Direcciones: `FACTORY_ADDRESS`, `ENTRYPOINT_ADDRESS`, `PAYMASTER_ADDRESS`, `USDC_ADDRESS`
- Constantes: `USDC_DECIMALS`

---

## Backend (`server/`)

Runtime: Cloudflare Workers con Hono.

Responsabilidades principales:

1. Verificar Firebase ID Tokens con JWKS de Google (cache 1h)
2. Gestionar perfiles, usernames y links en KV
3. Crear cuentas smart account con clave publica P256 de passkey
4. Consultar balance ETH/USDC on-chain
5. Construir y enviar UserOperations (EntryPoint V09 + paymaster)
6. Normalizar firma P256 (low-s) antes de enviar UserOp
7. Fondear cuentas nuevas con 5 USDC de prueba (testnet faucet)

### Rutas API

| Metodo | Ruta | Auth | Descripcion |
|--------|------|------|-------------|
| GET | `/` | NO | Health check |
| GET | `/user/profile` | SI | Perfil del usuario (uid, walletAddress, username) |
| PUT | `/user/username` | SI | Define username unico (validacion: `[a-z0-9_-]{3,30}`, palabras reservadas) |
| GET | `/user/:username` | NO | Resuelve username publico (walletAddress) |
| GET | `/user/balance` | SI | Balance ETH + USDC on-chain |
| POST | `/account/create` | SI | Crea smart account desde passkey publica (credentialId, qx, qy) |
| GET | `/account/passkey` | SI | Consulta si el usuario tiene passkey registrada |
| PUT | `/account/passkey` | SI | Actualiza credentialId de passkey |
| POST | `/account/fund` | SI | Fondea 5 USDC de prueba (una vez por usuario) |
| GET | `/account/fund` | SI | Consulta si el usuario ya canjeo sus USDC de prueba |
| POST | `/links` | SI | Crea link de cobro (status: `pending`) |
| GET | `/links` | SI | Lista links del usuario (max 20) |
| GET | `/links/:id` | NO | Obtiene link publico |
| POST | `/pay/prepare` | SI | Arma UserOp sin firma, valida balance, devuelve `userOpHash` + `credentialId` |
| POST | `/pay/submit` | SI | Recibe assertion WebAuthn, normaliza S, codifica firma y envia `handleOps` |

### Normalizacion P256 (low-s)

En `/pay/submit`, el servidor normaliza el valor `s` de la firma P256:
- Si `s > N/2`, se reemplaza por `N - s`
- Esto es necesario porque OZ `P256.verify` rechaza firmas con `s` alto (proteccion contra maleabilidad)

### KV keys

| Key | Valor |
|-----|-------|
| `user:{uid}` | Perfil (walletAddress, username, etc.) |
| `username:{name}` | uid (mapeo inverso) |
| `credential:{uid}` | credentialId de passkey |
| `link:{id}` | Datos del link (amount, currency, reference, wallet, status, txHash, etc.) |
| `userlinks:{uid}` | Array de ids de links del usuario (max 100) |
| `pending:{userOpHash}` | UserOp pendiente entre prepare y submit |
| `funded:{uid}` | Timestamp de cuando se fondearon 5 USDC al usuario (control de faucet) |

---

## Frontend (`client/`)

### Despliegue

- **Vercel** con `client/vercel.json` que reescribe todas las rutas a `index.html` (SPA)
- Esto permite que rutas como `/:username` funcionen sin 404

### Tema y Estilos

Todo el styling es via **Tailwind CSS v4**. Los colores del tema se definen en `client/src/index.css`:

```css
@theme {
  --color-parmelia-blue: #A7D4DE;
  --color-parmelia-pink: #DEA6BC;
  --color-parmelia-gold: #DED9A6;
  --color-surface: #1a1a1a;
  --color-surface-2: #2a2a2a;
  --color-muted: #888;
  --font-family-brand: "Shippori Antique", system-ui, sans-serif;
}
```

- Fondo body: `#000` (negro)
- Texto: `#fff` (blanco)
- Toasts: libreria `sileo` configurada en App.tsx

### Rutas de app

| Ruta | Componente | Auth | Descripcion |
|------|------------|------|-------------|
| `/login` | Login | NO | Login con Google |
| `/` | Home | SI | Dashboard principal |
| `/cobrar` | CreateLink | SI | Crear link de cobro |
| `/pagar` | PayPage | SI | Pagar (redirige desde menu) |
| `/scan` | ScanQR | SI | Escanear QR con camara |
| `/pay` | PayPage | Publica | Pagar link (query: `?id=`) |
| `/pay/status` | PaymentStatus | NO | Comprobante de pago |
| `/settings` | Settings | SI | Configuracion de cuenta |
| `/:username` | PayPage | Publica | Pagar a un usuario por username |

### Paginas

#### Home.tsx
- **Balance**: Muestra saldo USDC y ETH con selector de moneda
- **Transacciones**: Solo muestra links con `status === "paid"` (los pendientes no aparecen)
- **Block explorer**: Cada transaccion pagada es un link a `https://base-sepolia.blockscout.com/tx/{txHash}`
- **Menu QR**: Boton flotante con 2 opciones: **Cobrar** (`/cobrar`) y **Pagar** (`/scan`)
- **Crear wallet**: Si no tiene wallet, muestra boton para crear cuenta con passkey

#### CreateLink.tsx
- Formulario: red, moneda (USDC/ETH), monto, referencia
- Resultado: Muestra QR con el link de pago
- **Descargar**: Captura el card QR como imagen PNG usando `html-to-image` (identico a la app)
- **Compartir**: Usa `navigator.share` con URL del link, o copia al clipboard

#### PayPage.tsx
- Carga link por `?id=`, o perfil por `/:username`, o muestra formulario manual
- Flujo de pago en 2 pasos: `prepare` → firma biometrica → `submit`
- Feedback de latencia: muestra "Conexion lenta" despues de 5 segundos

#### PaymentStatus.tsx
- Muestra comprobante: "Pagaste", monto, destinatario, icono check
- **Descargar**: Captura el card como imagen PNG usando `html-to-image` (identico a la app)
- **Compartir**: Genera imagen del comprobante y la comparte via `navigator.share` con archivo PNG

#### ScanQR.tsx
- Escaneo QR con camara usando `jsqr`
- Usa `requestVideoFrameCallback` con fallback a `requestAnimationFrame`
- Constraints de calidad: resolucion ideal 1920x1080, facingMode environment
- Feedback: vibracion + sonido al detectar QR
- Throttle: analisis cada 120ms, downscale a max 960px ancho
- Validacion: solo navega si la URL es del mismo origen
- Boton manual para ingresar wallet directamente

#### Settings.tsx
- **Perfil**: Foto y nombre de Google
- **Username**: Campo para definir/cambiar username unico
- **Wallet**: Direccion con boton de copiar
- **Passkey**: Estado de passkey (registrada/no registrada), boton para registrar/cambiar
- **USDC de prueba**: Boton "Obtener 5 USDC gratis" (una vez por usuario, muestra estado canjeado)

### WebAuthn en cliente

Archivo: `client/src/webauthn.ts`

- `createPasskey(username)`
  - Crea credencial de plataforma (`navigator.credentials.create`)
  - Extrae `qx` y `qy` desde SPKI (clave publica P256)
  - Devuelve `credentialId`, `qx`, `qy`

- `signWithPasskey(credentialId, challenge)`
  - Dispara biometria (`navigator.credentials.get`)
  - Extrae `authenticatorData`, `clientDataJSON`, firma DER
  - Convierte DER a `r` y `s`

---

## Contratos

### AccountWebAuthn.sol

Smart account con:

- `Account` (ERC-4337)
- `SignerWebAuthn` / `SignerP256` (verificacion P256 WebAuthn)
- `ERC7821` (ejecucion por lotes)
- `ERC7739`
- `Initializable`

Inicializacion:

- `initializeWebAuthn(qx, qy)`

Ejecucion:

- `execute(bytes32 mode, bytes executionData)`
- El servidor usa `CALLTYPE_BATCH` (`0x01`) y manda un solo item en el array

### AccountFactory.sol

- `cloneAndInitialize(bytes initCallData)` → despliega clone minimal proxy
- `predictAddress(bytes initCallData)` → predice direccion con CREATE2

### ParmeliaPaymaster.sol

- Paymaster que paga gas por los usuarios
- Fondeado por el EOA del servidor

---

## Flujos Principales

### 1) Crear wallet

1. Usuario inicia sesion con Google
2. Cliente llama `createPasskey()` → prompt biometrico → obtiene `credentialId`, `qx`, `qy`
3. Cliente envia `POST /account/create` con las claves publicas
4. Servidor despliega cuenta via `factory.cloneAndInitialize()` con `qx`, `qy`
5. Servidor guarda `credential:{uid}` y `walletAddress` en KV
6. Servidor auto-fondea 5 USDC de prueba a la nueva cuenta (best-effort, no bloquea creacion)

### 2) Cobrar (crear link)

1. Usuario llena formulario (monto, referencia)
2. `POST /links` crea link con `status: "pending"` en KV
3. Se muestra QR con URL del link
4. El link aparece en el historial solo cuando alguien lo pague (`status: "paid"`)

### 3) Pagar (no-custodial)

1. Cliente hace `POST /pay/prepare` con linkId, wallet, amount, currency
2. Servidor valida balance suficiente (USDC o ETH on-chain)
3. Servidor construye UserOp y devuelve `userOpHash` + `credentialId`
4. Cliente firma `userOpHash` con `signWithPasskey()` (prompt biometrico)
5. Cliente envia assertion a `POST /pay/submit`
6. Servidor normaliza `s` (low-s), codifica `WebAuthnAuth` struct
7. Servidor envia `handleOps` al EntryPoint V09
8. Servidor verifica `UserOperationEvent.success === true`
9. Si el pago fue a un link, se actualiza `status: "paid"` con `txHash`

### 4) Escanear QR para pagar

1. `/scan` abre camara con constraints de calidad
2. `jsqr` analiza frames cada 120ms
3. Al detectar QR: vibracion + sonido, valida que URL sea del mismo origen
4. Navega automaticamente a la URL del link de pago

### 5) Gestionar passkey

1. `GET /account/passkey` → verifica si hay passkey registrada
2. `PUT /account/passkey` → registra nueva passkey (crea nueva credencial en dispositivo, actualiza `credential:{uid}` en KV)

### 6) Faucet de prueba (testnet)

- Al crear wallet nueva, el servidor transfiere automaticamente 5 USDC desde el EOA bundler
- Para usuarios existentes que no recibieron fondos: boton en Settings "Obtener 5 USDC gratis"
- Limitado a 1 vez por usuario (controlado por `funded:{uid}` en KV)
- El EOA bundler debe tener USDC suficiente para fondear usuarios

---

## Variables de Entorno

### Cliente (`client/.env`)

| Variable | Descripcion |
|----------|-------------|
| `VITE_FIREBASE_API_KEY` | Firebase API key |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase auth domain |
| `VITE_FIREBASE_PROJECT_ID` | Firebase project ID |
| `VITE_FIREBASE_APP_ID` | Firebase app ID |
| `VITE_SERVER_URL` | URL del backend (default: `https://server.parmelia.workers.dev`) |
| `VITE_APP_URL` | URL del frontend (default: `https://parmelia.vercel.app`) |

### Servidor (`wrangler.jsonc` + secrets)

| Variable | Tipo | Descripcion |
|----------|------|-------------|
| `FIREBASE_PROJECT_ID` | var | ID del proyecto Firebase |
| `RPC_URL` | secret | RPC de Base Sepolia |
| `PRIVATE_KEY` | secret | Clave privada del EOA bundler |
| `PARMELIA_KV` | binding | Cloudflare KV namespace |

---

## Seguridad y Modelo de Custodia

- El servidor **no guarda** la clave privada P256 de firma de usuario.
- El servidor guarda solo `credentialId` para identificar que passkey usar.
- La firma se hace en el autenticador del dispositivo (passkey).
- Si el usuario no tiene passkey registrada para esa cuenta, no puede firmar hasta registrar una.
- El EOA del servidor paga gas/bundle; no autoriza por si solo mover fondos de la smart account.
- Las firmas P256 se normalizan a low-s para cumplir con la validacion de OZ.
- Username validado server-side: regex `[a-z0-9_-]{3,30}` + lista de palabras reservadas.
- Firebase token verificado con JWKS publicas de Google.
- CORS abierto (`*`) — la autenticacion real es via Firebase token.

### Limitacion actual (importante)

- El backend hoy maneja **1 passkey por usuario** (`credential:{uid}`).
- Si una cuenta fue creada antes del flujo passkey (wallet existente pero sin `credentialId`), `POST /pay/prepare` falla con "Passkey not found".
- En ese estado, `POST /account/create` devuelve `409 Account already exists`, por lo que se requiere una ruta de migracion/registro de passkey para cuentas legacy.
- En otro dispositivo, el pago solo funciona si la passkey ya esta sincronizada (por ejemplo, llavero en la nube). Si no esta sincronizada, la firma falla hasta registrar una passkey valida para esa cuenta.
- `PUT /account/passkey` actualmente solo actualiza el `credentialId` en KV, no cambia la clave publica on-chain (requeriria UserOp firmada con la passkey actual).

---

## Estado Actual

- Contratos desplegados y en uso en Base Sepolia (EntryPoint V09)
- Backend en Cloudflare Workers con flujo `prepare/submit`
- Cliente en Vercel con SPA rewrites
- Firma WebAuthn real con biometria (no-custodial)
- Normalizacion low-s de firmas P256
- Historial de transacciones filtrado (solo pagadas) con links a block explorer
- Descarga de QR y comprobante como imagen identica a la app (`html-to-image`)
- Escaner QR con camara, vibracion y audio feedback
- Gestion de passkey en Settings
- Feedback de conexion lenta (5s timeout)
- Flujo consolidado: Cobrar + Pagar (escanear QR o manual)
- Faucet testnet: 5 USDC gratis al crear wallet o desde Settings (una vez por usuario)

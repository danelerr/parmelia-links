# Parmelia Links - Arquitectura del Proyecto

## Resumen

**Parmelia Links** es una web app de links de cobro y pagos cripto sobre **Account Abstraction (ERC-4337)** en **Base Sepolia**.

El producto combina cuatro piezas principales:

- **Firebase Auth + Google login** para identidad dentro de la app.
- **Passkeys WebAuthn (P256)** para firmar operaciones de la wallet en el dispositivo.
- **Smart accounts `AccountWebAuthn`** desplegadas por factory.
- **Cloudflare Worker + KV** para API, orquestacion de pagos, persistencia ligera y bundling.

El backend prepara y transmite UserOperations, pero **no custodia la clave privada de firma del usuario**. La autorizacion real de pagos ocurre con WebAuthn en el navegador del usuario.

---

## Stack Tecnologico

| Capa      | Tecnologia                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Contratos | Solidity 0.8.27, Foundry, OpenZeppelin v5                                                                                         |
| Cliente   | React 19, TypeScript 5.9, Vite 7, Tailwind CSS v4, Firebase Auth, SWR, react-router-dom, qrcode.react, jsqr, html-to-image, sileo |
| Servidor  | Hono, Cloudflare Workers, viem, jose, Cloudflare KV                                                                               |
| Shared    | Modulo TypeScript compartido para ABIs, direcciones y constantes                                                                  |
| Red       | Base Sepolia (84532)                                                                                                              |
| Deploy    | Cliente en Vercel, servidor en Cloudflare Workers                                                                                 |

---

## Estructura del Monorepo

```text
parmelia-links/
├── ARCHITECTURE.md
├── package.json
├── pnpm-workspace.yaml
├── client/
│   ├── package.json
│   ├── vite.config.ts
│   ├── vercel.json
│   └── src/
│       ├── App.tsx
│       ├── App.css
│       ├── authFetch.ts
│       ├── firebase.ts
│       ├── index.css
│       ├── main.tsx
│       ├── webauthn.ts
│       ├── components/
│       │   └── Logo.tsx
│       └── pages/
│           ├── CreateLink.tsx
│           ├── Home.tsx
│           ├── Login.tsx
│           ├── Onboarding.tsx
│           ├── PaymentStatus.tsx
│           ├── PayPage.tsx
│           ├── ScanQR.tsx
│           └── Settings.tsx
├── server/
│   ├── package.json
│   ├── wrangler.jsonc
│   └── src/
│       ├── index.ts
│       ├── middlewares/
│       │   └── auth.ts
│       ├── routes/
│       │   ├── account.routes.ts
│       │   ├── links.routes.ts
│       │   ├── pay.routes.ts
│       │   ├── transactions.routes.ts
│       │   └── user.routes.ts
│       ├── controllers/
│       ├── services/
│       └── utils/
├── contracts/
│   ├── src/
│   │   ├── AccountFactory.sol
│   │   ├── AccountWebAuthn.sol
│   │   └── ParmeliaPaymaster.sol
│   ├── script/
│   └── out/
└── shared/
    ├── EntryPointAbi.ts
    └── index.ts
```

Notas:

- El backend ya no vive en un solo `server/src/index.ts`; hoy esta modularizado por rutas.
- Las carpetas `controllers/`, `services/` y `utils/` existen como base para una siguiente extraccion de logica, pero la mayor parte del comportamiento actual todavia esta en los route handlers.

---

## Direcciones On-Chain (Base Sepolia)

Desplegadas y compartidas desde `shared/index.ts`.

| Contrato                          | Direccion                                    |
| --------------------------------- | -------------------------------------------- |
| AccountFactory                    | `0x8c91e55b11287c9c3970b64602fe50763fac0345` |
| EntryPoint (`ENTRYPOINT_ADDRESS`) | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` |
| ParmeliaPaymaster                 | `0xa1DC7ad6f4d2d0ea20bF5668F132c38c4f3c172D` |
| USDC Base Sepolia                 | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |

`shared/index.ts` tambien exporta:

- `accountWebAuthnAbi`
- `accountFactoryAbi`
- `entryPointAbi`
- `erc20Abi`
- `USDC_DECIMALS`

## Direcciones On-Chain (Monad Testnet)

Desplegadas el 30 de marzo de 2026. Estas direcciones se agregan como referencia de V2 en Monad y no reemplazan las de Base Sepolia.

| Contrato                                  | Direccion                                    |
| ----------------------------------------- | -------------------------------------------- |
| ERC7913WebAuthnVerifier                   | `0x900Cd8B955d88fD7b805eDcA939f0BFB069946bd` |
| AccountWebAuthnV2 (`implementation`)      | `0x536eD5b326d148fB0097b1f29F0Cb45862b91DC7` |
| AccountFactoryV2                          | `0x91Bf4c06D2A588980450Bb6AEDc43f1923f149c2` |
| ParmeliaPaymaster                         | `0xbcC45e484a1D448b3Df629aD91B0Cc6A7a7463b2` |
| EntryPoint (`ENTRYPOINT_ADDRESS`)         | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` |
| Paymaster sponsor signer inicial          | `0x75464f762bc50d0A0B127ab5a085504BF102Bb88` |

Notas:

- Las 4 direcciones de contrato anteriores quedaron desplegadas correctamente en Monad Testnet.
- El `stake` del paymaster se completo despues del deploy con la tx `0x7cf1843e525dfbd633b9509218581dee64cac381cd423c531863f11395875872`.
- El `deposit` del paymaster se completo despues con la tx `0x8f2460de828c1b304ed6251f62ff33a8738273d76bc9462e39faefc6048abc03`.
- `getDeposit()` del paymaster ahora devuelve `10000000000000000` wei (`0.01 MON`).

---

## Arquitectura Logica

### 1. Cliente (React/Vite)

Responsabilidades principales:

- Gestionar sesion con Google via Firebase.
- Forzar onboarding cuando el usuario ya inicio sesion pero aun no tiene wallet.
- Crear passkeys nuevas (`createPasskey`) y firmar UserOps (`signWithPasskey`).
- Consumir la API del worker con `fetchWithAuth`.
- Mostrar balance, historial, links de cobro, QR y ajustes de cuenta.

### 2. Worker API (Hono/Cloudflare)

Responsabilidades principales:

- Verificar Firebase ID tokens con JWKS de Google.
- Exponer la API de usuario, cuenta, links, pagos e historial.
- Desplegar smart accounts a partir de la clave publica WebAuthn.
- Preparar UserOperations ERC-4337 y enviarlas a `handleOps`.
- Registrar estado minimo en KV para perfiles, links, pending ops e historial.

### 3. Contratos y Account Abstraction (ERC-4337)

El proyecto utiliza el estándar ERC-4337 de Account Abstraction, lo que significa que los usuarios no interactúan con la blockchain usando cuentas tradicionales (EOAs), sino a través de Smart Accounts.

El flujo de transacciones y responsabilidades por contrato es:

- **`AccountWebAuthn.sol` (Smart Account):** Es el código base de la wallet del usuario, diseñado para validar biometría (passkeys). Solo existe un despliegue "maestro" (Implementation) en cadena. No hace falta exportar su dirección en los clientes (`shared/index.ts`) porque la app nunca le pide crear cuentas directamente, sino que se lo pide a la Factory.
- **`AccountFactory.sol`:** Es la fábrica de wallets. Despliega un "clon ligero" (Minimal Proxy) que apunta al `AccountWebAuthn` base, ahorrando muchísimo gas. Si Blockscout marca "22 transacciones" en la Factory, eso significa que la Factory fue invocada ~22 veces para crear las cuentas de los primeros 22 usuarios. Luego de esto, los usuarios interactúan directo con sus clones y no comunican más con la Factory.
- **`ParmeliaPaymaster.sol`:** Cubre el gas para mejorar la UX de pagos. En ERC-4337, las operaciones las agrupa y envía un **Bundler** (cuya EOA normal y ajena paga el gas real a la red, y es quien aparece en el campo "From" de Blockscout en la transacción madre). El contrato maestro `EntryPoint` es llamado por este Bundler, y a su vez, consulta _internamente_ a este Paymaster si autoriza cubrir los gastos. Como son transacciones internas, el contador público de transacciones del Paymaster en exploradores suele mostrar solo la actividad de "administración" (ej: añadir _stake_ y _deposit_ de gas por parte del dueño), pero internamente está pagando el fee de cientos de operaciones.

### 4. Cloudflare KV

Se usa como almacenamiento ligero para:

- perfiles de usuario,
- usernames,
- ultimo `credentialId` conocido,
- links de cobro,
- operaciones pendientes entre `prepare` y `submit`,
- historial enviado/recibido,
- control del faucet.

---

## Backend (`server/`)

### Entry point y middlewares

`server/src/index.ts` ahora solo compone la API:

- `cors()` global
- `logger()` global
- `authMiddleware` global
- healthcheck `GET /`
- montaje de rutas modulares:
  - `/user/transactions`
  - `/user`
  - `/account`
  - `/links`
  - `/pay`

`server/src/middlewares/auth.ts` define:

- `Bindings` y `AppContext` del worker
- cache de JWKS de Firebase por 1 hora
- `authMiddleware`, que deja `c.set("user", user | null)`
- `requireAuth`, que corta con `401` cuando no hay token valido

### Rutas API

| Metodo | Ruta                 | Auth | Descripcion                                                                                         |
| ------ | -------------------- | ---- | --------------------------------------------------------------------------------------------------- |
| GET    | `/`                  | NO   | Healthcheck (`Parmelia Links API (Modular)`)                                                        |
| GET    | `/user/profile`      | SI   | Perfil actual (`uid`, `walletAddress`, `username`)                                                  |
| PUT    | `/user/username`     | SI   | Define username unico y mantiene el indice inverso en KV                                            |
| GET    | `/user/:username`    | NO   | Resuelve username publico a `walletAddress`                                                         |
| GET    | `/user/balance`      | SI   | Balance on-chain de ETH y USDC de la wallet del usuario                                             |
| GET    | `/user/transactions` | SI   | Historial agregado de enviados, cobrados por links y transferencias ERC-20 detectadas en Blockscout |
| POST   | `/account/create`    | SI   | Crea la smart wallet desde `credentialId`, `qx`, `qy` y guarda la wallet en el perfil               |
| GET    | `/account/passkey`   | SI   | Devuelve estado de passkey: `hasStoredCredential`, `hasWallet`, `recoveryMode`, version de cuenta   |
| POST   | `/account/migrate`   | SI   | Migra una wallet legacy a V2, actualiza `walletAddress` y reescribe links pendientes                |
| PUT    | `/account/passkey`   | SI   | Agrega una nueva passkey a una wallet V2 existente sin cambiar de direccion                         |
| POST   | `/account/fund`      | SI   | Envia 5 USDC de prueba una sola vez                                                                 |
| GET    | `/account/fund`      | SI   | Consulta si el faucet ya fue canjeado                                                               |
| POST   | `/links`             | SI   | Crea un link de cobro en estado `pending`                                                           |
| GET    | `/links`             | SI   | Lista links del usuario (hasta 20)                                                                  |
| GET    | `/links/:id`         | NO   | Obtiene los datos publicos de un link                                                               |
| POST   | `/pay/prepare`       | SI   | Construye una UserOp sin firma, valida balance y devuelve `userOpHash` + `credentialId` opcional    |
| POST   | `/pay/submit`        | SI   | Recibe la assertion WebAuthn, normaliza la firma P256, llama `handleOps` y persiste el resultado    |

### Notas importantes del backend

- `POST /account/create` guarda `credential:{uid}` y `user:{uid}.walletAddress`, y ademas intenta hacer auto-fund de 5 USDC de forma best-effort.
- `GET /account/passkey` ya no solo responde si existe passkey; tambien indica si la cuenta esta en modo `stored` o `discoverable`.
- `POST /account/migrate` crea una wallet V2 nueva cuando detectamos una cuenta legacy y reescribe `walletAddress` en el perfil.
- Durante la migracion, los links `pending` del usuario se actualizan para apuntar a la nueva wallet.
- La migracion **no transfiere automaticamente fondos** desde la wallet anterior.
- `PUT /account/passkey` solo funciona sobre wallets V2 y prepara el calldata para agregar un signer adicional en la misma direccion.
- `POST /pay/prepare` guarda una entrada `pending:{userOpHash}` para enlazar la firma biometrica con la UserOp exacta que despues se enviara on-chain.
- `POST /pay/submit`:
  - normaliza `s` a low-s para cumplir con OpenZeppelin P256,
  - envia `handleOps` desde el EOA del servidor,
  - refresca `credential:{uid}` si el cliente reporta el `credentialId` usado,
  - registra transacciones enviadas en `sent:{uid}`,
  - marca links como `paid` cuando aplica.
- `GET /user/transactions` mezcla tres fuentes:
  - pagos enviados guardados en KV,
  - links cobrados guardados en KV,
  - transferencias ERC-20 encontradas en Blockscout,
    y deduplica por `txHash`.

---

## Modelo de Datos en KV

| Key                    | Valor                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `user:{uid}`           | Perfil del usuario (`uid`, `walletAddress`, `username`, etc.)                                       |
| `username:{name}`      | `uid` asociado al username                                                                          |
| `credential:{uid}`     | Ultimo `credentialId` conocido para ayudar a seleccionar la passkey correcta                        |
| `link:{id}`            | Link de cobro (`amount`, `currency`, `reference`, `wallet`, `status`, `txHash`, `paidAt`, `paidBy`) |
| `userlinks:{uid}`      | Lista de ids de links del usuario (se recorta a 100)                                                |
| `pending:{userOpHash}` | UserOp serializada y contexto del pago entre `prepare` y `submit`                                   |
| `sent:{uid}`           | Historial propio de pagos enviados                                                                  |
| `funded:{uid}`         | Timestamp del faucet ya canjeado                                                                    |

Punto importante:

- `credential:{uid}` es una **pista de UX**, no la fuente de verdad del signer. La autoridad criptografica real sigue siendo la clave publica P256 registrada on-chain en la smart account.

---

## Frontend (`client/`)

### Ruteo y proteccion

`client/src/App.tsx` mantiene dos estados globales relevantes:

- `user`: sesion Firebase actual
- `hasWallet`: si el perfil ya tiene wallet creada

Con eso, el frontend aplica este esquema:

| Ruta          | Requiere login | Requiere wallet      | Componente      | Comportamiento                             |
| ------------- | -------------- | -------------------- | --------------- | ------------------------------------------ |
| `/login`      | NO             | NO                   | `Login`         | Inicio de sesion con Google                |
| `/onboarding` | SI             | Debe no tener wallet | `Onboarding`    | Crea passkey + wallet inicial              |
| `/`           | SI             | SI                   | `Home`          | Dashboard principal                        |
| `/cobrar`     | SI             | SI                   | `CreateLink`    | Crear link de cobro                        |
| `/pagar`      | SI             | SI                   | `PayPage`       | Pago manual autenticado                    |
| `/scan`       | SI             | SI                   | `ScanQR`        | Escaneo QR con camara                      |
| `/settings`   | SI             | SI                   | `Settings`      | Perfil, username, wallet, passkey y faucet |
| `/pay`        | NO             | NO                   | `PayPage`       | Ruta publica/compartida para pagar un link |
| `/pay/status` | NO             | NO                   | `PaymentStatus` | Comprobante de pago                        |
| `/:username`  | NO             | NO                   | `PayPage`       | Ruta publica para pagar por username       |

Notas:

- Si un usuario inicia sesion pero aun no tiene wallet, las rutas internas lo redirigen a `/onboarding`.
- Las rutas publicas de pago siguen siendo accesibles sin wallet propia, pero para pagar de verdad el usuario debe iniciar sesion y tener una wallet operativa; de lo contrario `POST /pay/prepare` devolvera error.

### Paginas principales

#### `Onboarding.tsx`

- Crea la passkey en el dispositivo con biometria.
- Llama `POST /account/create`.
- Si la wallet se crea con exito, marca `hasWallet = true` y redirige al dashboard.

#### `Home.tsx`

- Usa **SWR** para traer perfil, balance e historial.
- Refresca balance cada 10s e historial cada 15s.
- Mezcla pagos enviados y recibidos en una sola lista ordenada por fecha.
- Muestra modal de detalle con link a Blockscout y descarga de comprobante como PNG.
- El menu flotante inferior abre las acciones de **Cobrar** y **Pagar**.

#### `CreateLink.tsx`

- Crea links de cobro con monto, moneda y referencia.
- Genera el QR con `qrcode.react`.
- Permite descargar el card como PNG y compartir el link.

#### `PayPage.tsx`

Soporta tres modos:

- pago de link (`/pay?id=...`),
- pago a username (`/:username`),
- pago manual a wallet o username (`/pagar`).

El flujo operativo es siempre de dos pasos:

1. `POST /pay/prepare`
2. firma con `signWithPasskey()`
3. `POST /pay/submit`

Tambien muestra feedback de conexion lenta despues de 5 segundos.

#### `PaymentStatus.tsx`

- Muestra comprobante de exito.
- Permite descargarlo como PNG.
- Permite compartir imagen o link on-chain si el dispositivo lo soporta.

#### `ScanQR.tsx`

- Usa `jsqr` para analizar frames de camara.
- Intenta usar `requestVideoFrameCallback`, con fallback a `requestAnimationFrame`.
- Selecciona camara trasera preferente y trata de activar enfoque continuo cuando el navegador lo soporta.
- Emite vibracion y sonido al detectar QR.
- Solo navega automaticamente si la URL pertenece al mismo origen de la app.

#### `Settings.tsx`

Actualmente centraliza:

- informacion del perfil Google,
- username publico,
- direccion de wallet,
- estado de passkey,
- faucet de 5 USDC,
- link al faucet externo de Circle.

Estado actual importante:

- **Hoy existe un boton temporal de "Restablecer passkey temporalmente"**.
- Ese boton llama `PUT /account/passkey`.
- Esta expuesto como herramienta de migracion/manual support y **puede cambiar la wallet del usuario**.
- No debe entenderse como rotacion segura del signer dentro de la misma direccion.

---

## WebAuthn y Gestion de Passkeys

### Creacion de passkey

`client/src/webauthn.ts` crea passkeys con:

- `authenticatorAttachment: "platform"`
- `residentKey: "required"`
- `userVerification: "required"`
- algoritmo ES256 / P256

Desde la attestation se extraen `qx` y `qy`, que son la clave publica que el contrato usara para validar firmas.

### Firma de pagos

`signWithPasskey(challenge, credentialId?)` funciona asi:

- si el servidor tiene un `credentialId` conocido, el cliente intenta usar **ese** primero con `allowCredentials`;
- se permiten transportes `internal` y `hybrid`;
- si no existe pista guardada, se usa el flujo discoverable sin `allowCredentials`.

Esto busca evitar un problema de UX importante: cuando varias passkeys del mismo RP estan sincronizadas en un dispositivo, el navegador puede ofrecer credenciales de otra cuenta si no se le da una pista concreta.

### `credentialId` guardado vs passkey real

El `credentialId` en KV no reemplaza la seguridad on-chain. Sirve para:

- acotar la seleccion de la passkey correcta,
- mejorar UX cuando el usuario tiene varias cuentas,
- refrescar la referencia despues de una firma exitosa.

La validacion final sigue ocurriendo contra la clave publica P256 registrada en la smart account.

### Recuperacion y cambio de dispositivo

Sin modificar contrato, el sistema actual soporta principalmente dos escenarios:

- **Passkey sincronizada**: el usuario conserva la misma wallet si su passkey esta disponible en el nuevo dispositivo dentro de su ecosistema de passkeys.
- **Modo discoverable**: si no hay `credentialId` reciente guardado, el navegador puede intentar descubrir una passkey compatible.

Esto mejora la portabilidad, pero **no equivale a recuperacion fuerte a nivel contrato**.

### Flujo legacy de `POST /account/migrate`

El endpoint actual existe como camino de migracion explicita para cuentas legacy y no como feature final de producto.

Comportamiento real:

1. recibe `credentialId`, `qx`, `qy`,
2. despliega o recupera una wallet V2 asociada a esa nueva clave publica,
3. actualiza `credential:{uid}`,
4. reescribe `user:{uid}.walletAddress` con la nueva direccion,
5. actualiza los links `pending` del usuario para que cobren en la nueva wallet.

Consecuencias:

- **No transfiere automaticamente los fondos de la wallet anterior**.
- **Puede cambiar la direccion operativa del usuario**.
- Debe tratarse como migracion legacy y no como "cambio de passkey" normal.

---

## Flujos Principales

### 1. Login y onboarding

1. El usuario inicia sesion con Google.
2. `App.tsx` consulta `/user/profile`.
3. Si no existe `walletAddress`, se redirige a `/onboarding`.
4. El cliente crea una passkey nueva.
5. El worker despliega la smart account y guarda el perfil.
6. El usuario entra al dashboard ya con wallet operativa.

### 2. Crear link de cobro

1. El usuario completa monto, moneda y referencia.
2. `POST /links` guarda el link con `status: "pending"`.
3. El frontend construye la URL publica y genera el QR.
4. El usuario puede descargar o compartir el link.

### 3. Pagar un link o username

1. El cliente resuelve destino y monto.
2. `POST /pay/prepare` valida balance, arma la UserOp y responde con `userOpHash`.
3. El navegador firma ese hash con WebAuthn.
4. `POST /pay/submit` normaliza la firma y envia `handleOps`.
5. Si aplica, el link queda marcado como `paid` y se registra la transaccion.

### 4. Ver historial

1. `Home.tsx` pide `/user/transactions`.
2. El backend une enviados, cobrados por link y ERC-20 detectados en Blockscout.
3. El frontend los presenta en una sola linea de tiempo.

### 5. Faucet de prueba

1. Al crear wallet, el servidor intenta enviar 5 USDC una sola vez.
2. Si no ocurrio en onboarding, el usuario puede intentar canjearlo desde `Settings`.
3. El worker usa la key del servidor para transferir desde el EOA de soporte y marca `funded:{uid}`.

---

## Contratos

### `AccountWebAuthn.sol`

El contrato mezcla:

- `Account`
- `EIP712`
- `ERC7739`
- `ERC7821`
- `SignerWebAuthn`
- `SignerP256`
- holders para ERC721/ERC1155

La inicializacion actual es:

- `initializeWebAuthn(bytes32 qx, bytes32 qy)`

Limitacion actual:

- `initializeWebAuthn` usa `initializer`, por lo que el signer solo puede definirse una vez por wallet desplegada.
- La version actual del contrato **no permite rotar passkey en la misma direccion**.

### Plan v2 ya documentado en comentarios del contrato

`contracts/src/AccountWebAuthn.sol` ya contiene un comentario de referencia para una futura v2 con:

- signer management en storage,
- `rotateWebAuthnSigner(...)` via self-call firmado por el signer actual,
- soporte para multiples passkeys,
- recovery con guardians o timelock,
- eventos y metadata de version para sincronizar mejor las pistas del backend.

Hasta que esa v2 exista, cualquier reset de passkey sigue siendo una **migracion de wallet**, no una rotacion segura del signer.

---

## Seguridad y Modelo de Custodia

- El login con Google autentica a la persona dentro de la app; **no firma pagos por si solo**.
- La autorizacion on-chain ocurre con la passkey WebAuthn del usuario.
- El servidor **no guarda** la clave privada de esa passkey.
- El EOA del servidor puede:
  - desplegar cuentas,
  - enviar el faucet,
  - pagar gas/bundling,
  - llamar `handleOps`.
- El EOA del servidor **no puede** mover fondos de la smart account sin una firma valida que el contrato acepte.
- El backend guarda `credentialId` solo como ayuda para seleccionar credencial; no como mecanismo custodial.
- Las firmas P256 se normalizan a low-s para cumplir con la verificacion de OpenZeppelin.
- Los usernames se validan server-side con regex y lista de palabras reservadas.
- El worker usa verificacion real de Firebase ID tokens con JWKS publicas de Google.
- CORS esta abierto (`*`), pero la autorizacion real depende del token Firebase y del signer WebAuthn.

Riesgo/limitacion vigente:

- El flujo temporal de `POST /account/migrate` puede cambiar la wallet activa del usuario y dejar fondos en la direccion anterior si se usa sin migracion manual de saldo.

---

## Variables de Entorno

### Cliente (`client/.env`)

| Variable                    | Descripcion              |
| --------------------------- | ------------------------ |
| `VITE_FIREBASE_API_KEY`     | Firebase API key         |
| `VITE_FIREBASE_AUTH_DOMAIN` | Firebase auth domain     |
| `VITE_FIREBASE_PROJECT_ID`  | Firebase project ID      |
| `VITE_FIREBASE_APP_ID`      | Firebase app ID          |
| `VITE_SERVER_URL`           | URL del backend          |
| `VITE_APP_URL`              | URL publica del frontend |

### Servidor (`server/wrangler.jsonc` + secrets)

| Variable              | Tipo    | Descripcion                                      |
| --------------------- | ------- | ------------------------------------------------ |
| `FIREBASE_PROJECT_ID` | var     | Proyecto Firebase usado para validar ID tokens   |
| `RPC_URL`             | secret  | RPC de Base Sepolia                              |
| `PRIVATE_KEY`         | secret  | EOA del worker para deploy, faucet y `handleOps` |
| `PARMELIA_KV`         | binding | Namespace KV de Cloudflare                       |

---

## Estado Actual

Snapshot de la arquitectura hoy:

- Backend modularizado en middlewares y rutas.
- Onboarding obligatorio para usuarios autenticados sin wallet.
- Home basado en SWR para balance e historial.
- Historial enriquecido con datos propios en KV y transferencias de Blockscout.
- Flujo de pago en dos pasos (`prepare` -> firma WebAuthn -> `submit`).
- Manejo de passkeys mas conservador: primero intenta el `credentialId` conocido para evitar mezclar passkeys de otras cuentas sincronizadas.
- `GET /account/passkey` distingue entre modo `stored` y `discoverable`.
- `Settings` y `Home` exponen una CTA explicita para migrar wallets legacy a V2.
- El contrato v1 no soporta rotacion del signer en la misma direccion; una futura v2 debera resolver recovery y multiples passkeys a nivel on-chain.

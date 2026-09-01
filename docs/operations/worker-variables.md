# Inventario canónico de secretos y configuración

**Última verificación:** 31 de agosto de 2026
**Alcance:** App Worker (`server`), Payments Worker
(`gatopago-payments-api`), cliente, dashboard, contratos y credenciales de
operación  
**Regla:** este documento registra nombres, procedencia y ubicación; nunca
registra valores secretos.

## Respuesta corta

- Cloudflare tiene **7 nombres** configurados en App y **7 nombres** en
  Payments. `wrangler secret list` permite comprobar los nombres, no recuperar
  sus valores.
- Vercel tiene únicamente configuración `VITE_*` para estos dos frontends. Es
  configuración pública incluida en el JavaScript del navegador, aunque Vercel
  la llame «Environment Variable».
- No se encontró un valor secreto versionado en el árbol Git actual. El
  historial conserva versiones antiguas de `client/.env` con la API key web de
  Firebase; es configuración pública del SDK, no una service-account ni una
  private key. Sí existen valores reales
  en archivos **ignorados por Git pero ubicados dentro de este checkout de
  OneDrive**: `server/.dev.vars`, `contracts/.env`, `client/.env`,
  `dashboard/.env` y caches locales de Vercel. «Ignorado» no significa «fuera
  del proyecto» ni «fuera de OneDrive».
- Los secretos generados para Payments durante Fase 2.1 están protegidos fuera
  del checkout con Windows DPAPI CurrentUser. Las private keys onchain no están
  dentro de ese archivo: provinieron del keystore Foundry `wallet-0x75`.
- En la corrección del 26-08-2026 se reutilizaron esos valores; **no se rotó
  ningún secreto** y ningún valor se imprimió o versionó.
- Durante esta verificación, un comando diagnóstico mostró en la salida de la
  sesión el `VERCEL_OIDC_TOKEN` local de Dashboard y el `ETHERSCAN_API_KEY`
  local. No se copiaron a este documento ni a Git, pero ambos deben tratarse
  como expuestos. El token OIDC es efímero; la API key de Etherscan debe rotarse.

## Qué es cada cosa

| Clase | Ejemplo | Dónde debe vivir | ¿Es visible al navegador? |
|---|---|---|---|
| Secreto de runtime | private key, service-account JSON, token operativo | Cloudflare Secret o gestor de secretos | No |
| Configuración sensible | RPC con API key en la URL, contexto ERC-7677 | Cloudflare Secret | No |
| Configuración pública | chain ID, URL pública, contract address, Firebase web config | `wrangler.jsonc`, Vercel `VITE_*` o archivo `.example` | Sí, si es `VITE_*` |
| Binding de infraestructura | D1, Queue, Durable Object, Service Binding | `wrangler.jsonc` | No; su nombre/ID no es una credencial |
| Secreto de comercio | `sk_test_*`, `whsec_*` | Hash o ciphertext en `PAYMENTS_DB` | Sólo se muestra una vez al comercio |
| Credencial de operador | sesión Wrangler/Vercel, keystore Cast | Perfil del SO o gestor dedicado | No |

Cloudflare recomienda `wrangler secret` para valores sensibles y `vars` para
configuración no sensible. Vite documenta que todo nombre `VITE_*` queda
incluido en el bundle del cliente. Referencias oficiales:

- [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- [Wrangler: comandos `secret`](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret)
- [Vercel Environment Variables](https://vercel.com/docs/environment-variables)
- [Vite: variables y modos](https://vite.dev/guide/env-and-mode)

## Qué se comprobó y qué no se puede comprobar

El snapshot remoto fue read-only. Se ejecutó `wrangler secret list` en ambos
Workers y `vercel env ls production` en ambos proyectos. No se leyó ni cambió
ningún valor.

Cloudflare no revela el valor de un Worker Secret después de cargarlo. Por eso
hay dos niveles de procedencia:

1. **Procedencia exacta comprobada:** el helper de Fase 2.1 muestra cómo creó y
   cargó los siete valores de Payments.
2. **Nombre remoto comprobado, origen histórico no demostrable:** siete valores
   de App ya existían; `TURNSTILE_SECRET_KEY` se añadió desde el candidato local
   ya existente, sin regenerarlo. Un archivo local con el mismo nombre no
   demuestra por sí solo que sea idéntico al valor remoto.

Cuando se perdió la fuente original de un secreto, la solución correcta es
rotarlo. No se debe «adivinar» copiando un valor de otro Worker o de otro
archivo.

## Mapa de almacenamiento actual

| Ubicación | Estado comprobado | Contenido sensible |
|---|---|---|
| Cloudflare `server` | Remoto, 8 nombres; el candidato magic-link no agrega ningún Secret | Sí; valores no recuperables |
| Cloudflare `gatopago-payments-api` | Remoto, 7 nombres | Sí; valores no recuperables |
| Vercel `parmelia` y `gatopago-dashboard` | Remoto | Sólo `VITE_*` pública en estos frontends |
| `server/.dev.vars` | Existe, ignorado, dentro de OneDrive | RPC, Turnstile y FCM poblados; las dos private-key entries presentes están vacías |
| `payments-worker/.dev.vars` | No existe | Ninguno |
| `contracts/.env` | Existe, ignorado, dentro de OneDrive | `PRIVATE_KEY`, `RPC_URL` y `ETHERSCAN_API_KEY` poblados |
| `client/.env` / `dashboard/.env` | Existen, ignorados | Configuración web pública `VITE_*`; no deben recibir secretos de servidor |
| `client/.vercel/.env.production.local` | Existe, ignorado | Cache Vercel; incluye un `VERCEL_OIDC_TOKEN` además de configuración pública |
| `dashboard/.env.local` | Existe, ignorado | `VERCEL_OIDC_TOKEN` poblado |
| `%USERPROFILE%\.foundry\keystores\wallet-0x75` | Existe fuera del checkout | Keystore cifrado de la cuenta testnet usada por el helper |
| `%LOCALAPPDATA%\GatoPago\phase-2-1\payments-generated-secrets.dpapi` | Existe fuera del checkout | Clave maestra de webhooks y token ops de Payments, protegidos con DPAPI |
| `%LOCALAPPDATA%\GatoPago\phase-2-1\d1-backup-key.dpapi` | Existe fuera del checkout | Clave de los backups D1, protegida con DPAPI |
| `%APPDATA%\com.vercel.cli\Data\auth.json` | Existe fuera del checkout | Sesión de Vercel CLI; nunca leerla ni copiarla al repo |
| GitHub Actions `GITHUB_TOKEN` | Se crea por job en CI | Token efímero administrado por GitHub; no hay que crear un secret manual |
| Historial Git `client/.env` | Existe en commits antiguos, no en el árbol actual | Firebase web config pública; puede activar detectores por el formato `AIza…`, pero no contiene service-account JSON |

Los dos tokens OIDC locales los genera Vercel y son de vida corta. Se pueden
volver a obtener con `vercel env pull`; no son una dependencia del código Vite.
Mientras estén en disco se tratan como secretos. DPAPI CurrentUser reduce la
exposición en reposo, pero no es un backup independiente: la recuperación
depende del perfil de Windows. Antes de mainnet debe existir una copia en un
gestor de secretos que no esté sincronizado por OneDrive.

## App Worker: `server`

### Configurados actualmente en Cloudflare

| Nombre | Clasificación y uso | Procedencia actual | Cómo obtener o regenerar | ¿Está en el checkout? |
|---|---|---|---|---|
| `AUTH_CODE_PEPPER` | Secreto aleatorio; HMAC de correo, IP, challenges de recovery y compatibilidad OTP legacy | Ya existía en App; origen exacto no verificable | Generar 48 bytes aleatorios en un gestor seguro. Rotarlo invalida challenges/proofs y OTP legacy pendientes | Nombre en la plantilla; no hay valor local poblado |
| `FCM_SERVICE_ACCOUNT` | JSON privado para Firebase Cloud Messaging | Ya existía; `server/.dev.vars` tiene un candidato local, pero no se puede probar igualdad | Firebase Console → Project settings → Service accounts → generar una clave nueva para una cuenta de mínimo privilegio | Sí, valor local ignorado; no en Git |
| `FIREBASE_SERVICE_ACCOUNT` | JSON privado para Admin API: consultar el correo verificado del UID durante recovery | Ya existía; origen exacto no verificable | Mismo flujo de Service Accounts; preferentemente una cuenta separada de FCM | Sólo nombre/plantilla local |
| `FIREBASE_WEB_API_KEY` | Identificador público Firebase que el Worker usa para solicitar `EMAIL_SIGNIN`; se conserva como Secret sólo para no ampliar su exposición operativa | Ya existía; no se puede comparar con Vercel | Firebase Console → Project settings → General → aplicación web → `apiKey` | Sí como `VITE_FIREBASE_API_KEY` pública; el valor remoto no es legible |
| `OPS_HEALTH_TOKEN` | Bearer secreto de `/health/ops` | Ya existía; origen exacto no verificable | Generar 48 bytes aleatorios y actualizar juntos Worker y monitor | Sólo nombre/plantilla local |
| `PRIVATE_KEY` | EOA de App para `handleOps` y CCTP personal | Ya existía; Cloudflare no permite recuperarla | Crear una EOA relayer dedicada, financiarla, drenar nonces pendientes y rotar el Secret | `server/.dev.vars` tiene el campo vacío; `contracts/.env` tiene otra key cuyo vínculo no está demostrado |
| `RPC_URL` | Endpoint EVM; sensible si contiene credencial del proveedor | Ya existía; hay un candidato local poblado, sin prueba de igualdad | Usar el RPC público de la red o crear un endpoint en el proveedor RPC elegido | Sí, valor local ignorado; no en Git |
| `TURNSTILE_SECRET_KEY` | Secret del widget que permite validar token, action y hostname | El 28-08-2026 se cargó en Cloudflare desde la entrada ya poblada de `server/.dev.vars`; no se generó ni rotó y el valor no se imprimió | Cloudflare Dashboard → Turnstile → widget → Secret key; actualizar coordinadamente con la sitekey si se reemplaza el widget | Sí, valor ignorado; no en Git |

La [configuración web de Firebase](https://firebase.google.com/docs/web/setup)
es pública por diseño; la autorización real depende de IAM, Security Rules y
App Check. Google recomienda restringir esa API key sólo a APIs Firebase. El
service-account JSON, en cambio, sí contiene una private key y es secreto. Véase
[Firebase Admin setup](https://firebase.google.com/docs/admin/setup) y
[administración de API keys Firebase](https://firebase.google.com/docs/projects/api-keys).

### Soportados por App pero ausentes del Secret Store remoto

| Grupo | Nombres | Cuándo se necesitan y de dónde salen |
|---|---|---|
| RPC por rol | `RPC_READ_URLS`, `RPC_WRITE_URLS`, `RPC_INDEXER_URLS`, `RPC_ARCHIVE_URLS` | Del proveedor RPC elegido para la red hogar. Se separan por capacidad; pueden heredar `RPC_URL` mientras no haya un plan dedicado |
| RPC App multichain | `APP_CHAIN_RPC_URLS` | JSON `chainId -> URLs` o roles `read/write/indexer/archive/bundler`. Se obtiene de los proveedores RPC de cada satélite; va a Secret si cualquier URL contiene API key. No está configurado remotamente y Fuji permanece fuera del rail |
| Bundler y CCTP | `BUNDLER_RPC_URLS`, `CCTP_RPC_URLS` | Dashboard del bundler ERC-4337 o proveedor RPC. Hoy `RELAYER_MODE=self` y CCTP puede usar RPC público |
| Roles onchain dedicados | `FAUCET_PRIVATE_KEY`, `RECOVERY_GUARDIAN_PRIVATE_KEY`, `PAYMASTER_SIGNER_PRIVATE_KEY`, `PAYMENT_ROUTER_SIGNER_PRIVATE_KEY` | Keystores/gestor de claves creados por GatoPago. Hoy testnet permite fallback; mainnet exige separación y falla cerrado |
| Alchemy Address Activity | `ALCHEMY_WEBHOOK_ID`, `ALCHEMY_WEBHOOK_SIGNING_KEY`, `ALCHEMY_ADDRESS_WEBHOOKS_JSON`, `ALCHEMY_NOTIFY_AUTH_TOKEN` | Dashboard Alchemy → Webhooks. Los flags remotos están apagados, por lo que hoy no se usan |
| Alchemy Custom Webhook | `ALCHEMY_CUSTOM_WEBHOOK_ID`, `ALCHEMY_CUSTOM_WEBHOOK_SIGNING_KEY` | Mismo dashboard; hoy deshabilitado |
| Paymaster ERC-7677 | `PAYMASTER_SERVICE_URL`, `PAYMASTER_SERVICE_CONTEXT_JSON` | Proveedor de paymaster seleccionado. No hay proveedor externo configurado; App usa `SPONSORSHIP_PROVIDER=parmelia` |
| Webhooks merchant legacy | `WEBHOOK_SECRET_ENCRYPTION_KEY`, `WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS` | Claves históricas sólo para rollback/soak del dominio que ahora pertenece a Payments |

La autenticación de la App no tiene `AUTH_EMAIL_PROVIDER`,
`AUTH_EMAIL_TIMEOUT_MS` ni `RESEND_API_KEY`. Firebase entrega los magic links con
la configuración del proyecto; por tanto no hay credencial de correo externa
que obtener, cargar o rotar. `APP_URL=https://app.parmelia.me` es una var pública
versionada y debe coincidir exactamente con un dominio autorizado en Firebase.
`AUTH_EMAIL_FROM=acceso@parmelia.me` y el binding `EMAIL` quedan únicamente como
canal opcional de alertas de seguridad/compatibilidad Business: una falla allí
no impide el login ni detiene la entrega FCM del outbox.

Passkey Security v2 desplegado agrega dos **vars públicas**, no Secrets:

| Nombre | Valor activo | Procedencia y obtención | ¿Está en Git? |
|---|---|---|---|
| `PASSKEY_RP_ID` | `app.parmelia.me` | Es el RP ID de las passkeys existentes y debe permanecer estable. Se obtiene de la decisión de dominio WebAuthn, no de Cloudflare, Vercel ni Firebase | Sí, en `server/wrangler.jsonc` |
| `PASSKEY_ALLOWED_ORIGINS` | `https://app.parmelia.me` | Origen exacto desde el que la App permite ceremonias WebAuthn. Sólo se amplía después de demostrar compatibilidad con el mismo RP ID | Sí, en `server/wrangler.jsonc` |

Fase 4A agrega tres nombres de configuración. Los dos primeros son públicos; el
tercero puede ser secreto según las URLs:

| Nombre | Candidato local | Función |
|---|---|---|
| `APP_ENABLED_CHAIN_KEYS` | `arbitrum-sepolia,avalanche-fuji` | Redes que la API y la UI pueden describir. No autoriza operaciones. |
| `APP_WALLET_RAIL_CHAIN_KEYS` | `arbitrum-sepolia,avalanche-fuji` | Kill switch de preparación/envío. Fuji está abierto en testnet para la prueba real de cuenta, passkey y AVAX/USDC; si falla un gate se retira de esta lista y se redespliega App Worker. |
| `APP_CHAIN_RPC_URLS` | ausente | Pools por chain y rol. No copiar valores de Payments; cada dominio conserva sus credenciales y límites. |

Ejemplo estructural sin credenciales:

```json
{
  "43113": {
    "read": "https://rpc-a.example,https://rpc-b.example",
    "write": "https://rpc-a.example",
    "indexer": "https://rpc-b.example",
    "archive": "https://rpc-c.example"
  }
}
```

No se debe duplicar el RP ID en `VITE_*`: el Worker lo liga al challenge y lo
devuelve también con cada operación que requiere firma. `VITE_APP_URL` conserva
otros usos del frontend, pero ya no decide el alcance WebAuthn. Para desarrollo,
`.dev.vars.example` usa `PASSKEY_RP_ID=localhost` y
`PASSKEY_ALLOWED_ORIGINS=http://localhost:5173`. Su ausencia falla cerrado en
cualquier entorno; mainnet rechaza además HTTP, `localhost` y loopback.

No todos los nombres de esa tabla son intrínsecamente secretos. Por ejemplo,
`ALCHEMY_WEBHOOK_NETWORK`, `WEBHOOK_SECRET_ENCRYPTION_KEY_ID`,
`PAYMASTER_SERVICE_EXPECTED_PAYMASTER`, `RPC_PROVIDER_CAPABILITIES` y las flags
son configuración pública y deben preferir `vars`. Una URL se trata como
secreta si incorpora una API key o token.

## Payments Worker: `gatopago-payments-api`

Los siete valores actuales se cargaron juntos mediante
[`scripts/configure-payments-secrets.ps1`](../../scripts/configure-payments-secrets.ps1).
Aquí sí existe trazabilidad exacta:

| Nombre remoto | Procedencia comprobada en Fase 2.1 | Recuperación/rotación | ¿Está en el checkout? |
|---|---|---|---|
| `PAYMENT_AUTHORIZATION_SIGNER_PRIVATE_KEY` | El helper descifró el keystore Foundry `wallet-0x75` y comprobó que la dirección coincidía con los routers testnet; no hay evidencia de cuándo o cómo se creó/importó originalmente esa cuenta | Crear signer dedicado, pausar/drainar quotes, cambiar `authorizationSigner` en cada router y después rotar el Secret | No; permanece en el keystore externo y Cloudflare |
| `PAYMENT_RELAYER_PRIVATE_KEY` | La misma key extraída de `wallet-0x75` durante el piloto testnet; el origen anterior del keystore no es reconstruible desde Git | Crear y fondear relayer CCTP dedicado; drenar leases/nonces y rotar | No; permanece en el keystore externo y Cloudflare |
| `PAYMENT_RPC_URLS` | JSON construido con los RPC públicos de `contracts/.env.example` más proveedores independientes: PublicNode para Arbitrum/Fuji y dRPC + Tenderly para Base | El helper valida HTTPS, al menos dos hostnames y `eth_chainId` para cada endpoint antes de subir Secrets; se pueden reemplazar por endpoints administrados por chain | Los siete orígenes públicos están en Git; el JSON remoto no |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` | 32 bytes aleatorios generados con CSPRNG | Recuperable desde `payments-generated-secrets.dpapi` bajo el mismo usuario Windows; para rotar, usar el keyring anterior y recifrar todas las filas | No en el checkout; sí en DPAPI y Cloudflare |
| `WEBHOOK_SECRET_ENCRYPTION_KEY_ID` | Etiqueta pública elegida por el helper (`2026_08_phase2_1`) | Elegir un ID nuevo en cada rotación | El ID está en el script; el binding remoto se cargó como Secret |
| `WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS` | `{}` porque no existía una clave anterior de Payments | Agregar temporalmente `id -> clave` durante una rotación y retirar sólo cuando `remaining=0` | Sólo el valor vacío reproducible; ninguna clave histórica está en Git |
| `OPS_HEALTH_TOKEN` | 48 bytes aleatorios generados con CSPRNG | Recuperable desde el archivo DPAPI; al rotar se actualiza también el monitor/cliente ops | No en el checkout; sí en DPAPI y Cloudflare |

Hay una limitación deliberadamente visible: durante Fase 2.1 el signer y el
relayer reutilizaron `wallet-0x75`, y el helper abrió ese keystore con contraseña
vacía. Es aceptable únicamente para el piloto testnet actual, donde
`PAYMENT_LIVE_ENABLED=false`. Antes de habilitar mainnet se deben crear dos
cuentas distintas, protegidas con contraseña no vacía o un gestor/HSM, y rotar
ambos Secrets. No se debe reutilizar esa key para App, faucet, paymaster o
guardian.

`CIRCLE_API_KEY` está soportada pero **no está configurada**. Se crea en
[Circle Console → API & Client Keys](https://developers.circle.com/contracts/create-api-key)
con el menor alcance posible. No es la private key del relayer y no reemplaza
gas en destino.

`PAYMENT_FEE_POLICY_JSON`, `PAYMENT_PLATFORM_FEE_RECIPIENT`,
`PAYMENT_CONFIRMATIONS_JSON`, `PAYMENT_ROUTER_PREFLIGHT_ENABLED`,
`PAYMENT_LIVE_ENABLED`, `PAYMENTS_BOOTSTRAP_MODE` y
`PAYMENTS_DATA_CUTOVER_CHECKSUM` son configuración, no credenciales. El checksum,
los IDs de D1/Queue, los chain IDs y las direcciones de contratos también son
públicos.

## Vercel: cliente y dashboard

### Regla innegociable de Vite

Todo `VITE_*` es público. Nunca se deben crear nombres como
`VITE_PRIVATE_KEY`, `VITE_FIREBASE_SERVICE_ACCOUNT`, `VITE_CIRCLE_API_KEY` o
`VITE_TURNSTILE_SECRET_KEY`.

### Cliente `parmelia` — Production

Nombres remotos comprobados:

- Firebase web: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`,
  `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`,
  `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`.
- Firebase público opcional: `VITE_FIREBASE_VAPID_KEY` y
  `VITE_FIREBASE_MEASUREMENT_ID`.
- GatoPago: `VITE_SERVER_URL`, `VITE_PAYMENTS_API_URL`, `VITE_APP_URL` y
  `VITE_CHAIN_KEY`.
- Anti-abuso público: `VITE_TURNSTILE_SITE_KEY`.
- Overrides públicos opcionales: `VITE_CHAIN_NAME`,
  `VITE_NATIVE_TOKEN_SYMBOL`, `VITE_CHAIN_EXPLORER_URL`, `VITE_FAUCET_URL`,
  `VITE_FAUCET_LABEL` y `VITE_SUPPORT_TELEGRAM_URL`. El último tiene fallback
  en código y no está configurado actualmente en Vercel Production.

Durante el corte remoto de Fase 2.1 sólo se añadió al proyecto existente
`VITE_PAYMENTS_API_URL`, a partir de la URL pública de Payments.
Los demás
nombres ya existían; Vercel no aporta evidencia de su origen histórico. El
archivo ignorado `client/.env` contiene los seis valores Firebase, VAPID,
Measurement ID, sitekey, URLs y chain key; no contiene
`VITE_PAYMENTS_API_URL`, que sí está en Vercel y en la plantilla.

### Dashboard `gatopago-dashboard` — Production

Nombres remotos comprobados:

- Los seis `VITE_FIREBASE_*` básicos anteriores.
- `VITE_APP_API_URL`, `VITE_PAYMENTS_API_URL`, `VITE_SITE_URL` y
  `VITE_TURNSTILE_SITE_KEY`.

El helper de Fase 2.1 tomó los seis Firebase desde `dashboard/.env`, la sitekey
desde `client/.env` y las tres URLs desde constantes públicas del proyecto. Los
valores se entregaron a Vercel por stdin y con `--no-sensitive`, porque son
datos públicos del bundle. `dashboard/.env` todavía conserva el nombre legacy
`VITE_SERVER_URL`; Vercel Production usa las URLs separadas.

El 26-08-2026 se desactivó Vercel SSO para `gatopago-dashboard` y se comprobó
acceso anónimo hasta el login propio de GatoPago. No se añadió ninguna variable,
Project ID ni secret de Reown/WalletConnect; esos proveedores no forman parte de
la arquitectura.

### Cómo obtener cada valor público

| Familia | Fuente |
|---|---|
| `VITE_FIREBASE_*` básico | Firebase Console → Project settings → General → Your apps → web config |
| `VITE_FIREBASE_VAPID_KEY` | Firebase Console → Project settings → Cloud Messaging → Web Push certificates |
| `VITE_FIREBASE_MEASUREMENT_ID` | Firebase/Google Analytics del mismo web app |
| `VITE_TURNSTILE_SITE_KEY` | Cloudflare Dashboard → Turnstile → widget. Es la **sitekey**, no la secret key |
| URLs y `VITE_CHAIN_KEY` | Configuración pública propiedad de GatoPago; los defaults viven en `.env.example` y `shared/networks.ts` |
| Overrides de chain, faucet y soporte | Configuración pública opcional del producto; si se omite se usa `shared/networks.ts` o el fallback de código |

La pareja Turnstile se crea desde el
[Dashboard de Turnstile](https://developers.cloudflare.com/turnstile/get-started/widget-management/dashboard/):
sitekey al frontend, secret key sólo a App Worker. Nunca se intercambian.

## Contratos y cuentas onchain

### Qué hay actualmente

- `contracts/.env.example` está versionado y contiene sólo RPC públicos,
  direcciones placeholder/públicas y nombres vacíos de API keys.
- `contracts/.env` está ignorado, pero existe dentro de OneDrive con
  `PRIVATE_KEY`, `RPC_URL` y `ETHERSCAN_API_KEY` poblados. No se imprimieron ni
  compararon la private key o el RPC; la API key de Etherscan sí apareció por
  error en la salida diagnóstica y debe rotarse. El origen histórico de los tres
  valores no está documentado.
- `wallet-0x75` está fuera del checkout en el keystore de Foundry. El helper de
  Payments lo usó y verificó su dirección contra los manifests testnet. No se
  volvió a descifrar durante este inventario. Git no registra si originalmente
  fue generado con Cast o importado; sólo están comprobados el archivo, la
  contraseña vacía usada por el helper y su papel en Fase 2.1.

La private key de `contracts/.env` no debe asumirse igual a `wallet-0x75` ni a
ningún Secret remoto sólo porque el nombre coincida. Antes de mainnet se debe
eliminar la dependencia de private keys en `.env` y usar cuentas dedicadas.

Las API keys de explorer son opcionales y sólo verifican source code; no firman
transacciones. `ETHERSCAN_API_KEY` se obtiene iniciando sesión en Etherscan y
creando una key en **API Dashboard**. Etherscan API V2 permite usar una misma
key para las cadenas EVM soportadas mediante `chainid`; `BASESCAN_API_KEY` y
`SNOWTRACE_API_KEY` quedan como nombres de compatibilidad de scripts antiguos.
Sourcify sigue siendo la alternativa preferida cuando no requiere API key.
Véase [Etherscan API Keys](https://info.etherscan.com/apis/) y
[Etherscan API V2](https://docs.etherscan.io/introduction).

### Crear o importar una cuenta sin exponerla

Con Cast 1.7.1, importar una cuenta existente usa prompt oculto para private key
y contraseña:

```powershell
cast wallet import gatopago-payment-signer --interactive
```

Para generar una nueva, consultar primero `cast wallet new --help` y escribir
el keystore cifrado en el directorio de Foundry con un nombre de rol. Nunca usar
`--unsafe-password`, contraseña vacía ni mostrar `cast wallet
decrypt-keystore` en una guía operativa. La dirección pública se puede verificar
sin exportar la key:

```powershell
cast wallet address --account gatopago-payment-signer
```

Para cargar un Secret, Wrangler solicita el valor por prompt:

```powershell
pnpm --filter payments-worker exec wrangler secret put NOMBRE --name gatopago-payments-api
pnpm --filter server exec wrangler secret put NOMBRE --name server
```

`wrangler secret put` crea/despliega una versión del Worker. Sólo se ejecuta en
una ventana autorizada, después del preflight y con rollback preparado. Nunca
pasar private keys como argumento, `echo`, log o archivo temporal dentro del
checkout.

## Secretos creados por los comercios

| Secreto | Cómo se obtiene | Qué almacena GatoPago | Cómo se rota |
|---|---|---|---|
| API key `sk_test_*` / `sk_live_*` | Dashboard → API Keys → crear | Sólo prefijo y SHA-256 en `PAYMENTS_DB`; el raw se devuelve una vez | Crear otra, migrar integración y revocar la anterior |
| Webhook secret `whsec_*` | Dashboard → Webhooks → crear endpoint | Ciphertext AES-GCM y `secret_key_id` en `PAYMENTS_DB`; el raw se devuelve una vez | Crear endpoint/secret nuevo, comprobar firmas y deshabilitar el anterior |

Estos valores no son Worker Secrets ni variables Vercel y nunca deben entrar en
`.env.example`. El comercio es responsable de guardarlos después de la única
visualización. Los tokens Firebase, challenges/passkeys y tokens Turnstile son
credenciales efímeras de usuario, no configuración permanente.

## Backups y credenciales de herramientas

- Los dos backups D1 están cifrados con AES-256-GCM bajo
  `%LOCALAPPDATA%\GatoPago\phase-2-1\backups`.
- `d1-backup-key.dpapi` protege la clave del backup con DPAPI CurrentUser. El ID
  de clave y los checksums del manifest no son secretos.
- `payments-generated-secrets.dpapi` protege el token ops y la clave de webhooks
  generados; no contiene el private key de `wallet-0x75`.
- `wrangler login` y `vercel login` administran sesiones del operador fuera del
  repo. No se copian sus tokens a scripts, CI, `.env` ni documentación.
- `VERCEL_OIDC_TOKEN` es un token real y efímero. Vercel lo genera en build o lo
  descarga con `vercel env pull`; no lleva prefijo `VITE_` y no debe llegar al
  bundle.

| Nombre de operador/CI | Qué es y procedencia | Cómo obtenerlo | ¿Está en el proyecto? |
|---|---|---|---|
| `D1_BACKUP_ENCRYPTION_KEY` | Clave AES-256-GCM de 32 bytes para `scripts/d1-backup.mjs`; la fuente recuperable actual es el archivo DPAPI, pero el comando original que la generó no quedó versionado | Generar 32 bytes con CSPRNG y guardarlos primero en un gestor; entregarlos sólo al proceso que hace backup/restore | No en Git ni en Worker; sí fuera del checkout en `d1-backup-key.dpapi` |
| `D1_BACKUP_ENCRYPTION_KEY_ID` | Etiqueta pública corta de la clave de backup | Elegir un ID nuevo por rotación, sin incluir material secreto | Puede aparecer en manifests; no es secreto |
| `WEBHOOK_SECRET_ENCRYPTION_KEY` en `split-payments-d1.mjs` | Clave destino usada una sola vez para cifrar secretos importados | Recuperar la clave activa de Payments desde el gestor/DPAPI y exponerla sólo al proceso de cutover | No debe persistir en el checkout; el helper de Payments la conserva cifrada fuera de él |
| `GATOPAGO_LOAD_TOKEN` | Firebase ID token efímero para una identidad de staging durante pruebas de carga | Iniciar sesión en staging y obtener el ID token de esa sesión; preferir `--token-file` fuera del repo | No se encontró en el proyecto; `PARMELIA_LOAD_TOKEN` es sólo alias legacy |
| `GITHUB_TOKEN` | GitHub App installation token del workflow de seguridad | GitHub Actions lo crea automáticamente al iniciar cada job y lo revoca/expira después | Sólo existe la referencia `${{ secrets.GITHUB_TOKEN }}` en el YAML; no hay valor local ni secret manual |
| `VERCEL_OIDC_TOKEN` | Token OIDC corto emitido por Vercel para proyecto/entorno | Vercel lo inyecta en build; para desarrollo, `vercel env pull` | Sí existen dos copias ignoradas dentro del checkout; no es usado por el bundle Vite |
| Sesión Vercel CLI | Credencial de operador administrada por la CLI | `vercel login`; para CI externo, crear un token separado y de mínimo alcance | Fuera del checkout en el perfil del SO |
| Sesión Wrangler | Credencial de operador administrada por la CLI | `wrangler login` o token de API de mínimo alcance en CI | Fuera del checkout; su ubicación/valor no se documenta ni inspecciona |

`CLOUDFLARE_WORKERS_SUBDOMAIN`, `GATOPAGO_DASHBOARD_VERCEL_PROJECT`,
`CHAIN_KEY`, `RPC_PROVIDER_CAPABILITIES` y los límites de pruebas son parámetros
operativos, no secretos. `APPDATA`, `LOCALAPPDATA`, `CI`, `NO_COLOR` y
`VERCEL_TELEMETRY_DISABLED` son variables del sistema/herramienta.

Los wrappers `prepare-payments-semantic-split.ps1` e
`invoke-phase2-preflight.ps1` recuperan la clave de webhooks existente desde
`payments-generated-secrets.dpapi`, la inyectan sólo al proceso hijo y restauran
el entorno en `finally`. No rotan, imprimen ni crean claves. El nuevo corte
guarda los webhooks importados en el mismo formato `enc:v2:<key-id>` que consume
Payments; la D1 histórica usó la etiqueta incompatible `legacy-cutover` y por
eso debe reemplazarse, no reetiquetarse.

GitHub documenta que `GITHUB_TOKEN` se crea automáticamente por job y está
limitado al repositorio. El workflow fija `permissions: contents: read`.
Referencia: [GitHub `GITHUB_TOKEN`](https://docs.github.com/en/actions/concepts/security/github_token).
Vercel documenta que los tokens OIDC de desarrollo descargados localmente duran
12 horas; expiración no sustituye borrar copias innecesarias.
Referencia: [Vercel OIDC](https://vercel.com/docs/oidc).

## Hallazgo de exposición del 25 de agosto de 2026

Un comando de inventario imprimió por error dos valores ignorados en la salida
de esta sesión: `dashboard/.env.local:VERCEL_OIDC_TOKEN` y
`contracts/.env:ETHERSCAN_API_KEY`. No se mostraron private keys onchain,
service-account JSON ni los Secrets de Cloudflare.

Acción requerida:

1. Dejar expirar y eliminar las copias locales del OIDC token; ejecutar
   `vercel env pull` sólo cuando una tarea local realmente lo necesite.
2. Revocar la API key actual desde Etherscan API Dashboard, revisar su usage log
   desde esta fecha y crear otra únicamente si seguirá usándose.
3. Guardar el reemplazo fuera de OneDrive y cargarlo al proceso de verificación
   sin imprimirlo. Sourcify no requiere ese reemplazo.

No se hizo ninguna revocación, rotación, carga de Secret ni despliegue durante
esta actualización documental.

## Rotación: orden seguro

| Tipo | Orden mínimo |
|---|---|
| Private key de autorización | Deshabilitar nuevas quotes, esperar TTL, cambiar signer onchain, cargar Secret nuevo, desplegar y comprobar preflight/health |
| Private key relayer | Drenar leases y nonces, financiar la nueva dirección, cargar Secret, desplegar y comprobar receipts |
| Firebase service account | Crear key nueva, cargarla, verificar auth/push, revocar la anterior en GCP y eliminar copias locales |
| `AUTH_CODE_PEPPER` | Cargar valor nuevo y asumir que códigos/proofs pendientes dejan de ser válidos |
| Turnstile | Rotar en Cloudflare; actualizar sitekey pública si cambia y secret key sólo en App; desplegar ambos lados coordinadamente |
| Webhook encryption master | Añadir la anterior al keyring, activar ID/key nueva, recifrar hasta `remaining=0`, retirar la anterior |
| `OPS_HEALTH_TOKEN` | Actualizar Worker y monitor en la misma ventana; no reutilizar entre App y Payments |
| RPC/API provider | Crear credencial nueva, cargar, comprobar health/requests y revocar la anterior |
| API key merchant | Crear nueva, migrar llamadas, revocar anterior |

## Comprobaciones seguras

Estos comandos muestran nombres y estado, nunca valores secretos:

```powershell
pnpm --filter server exec wrangler secret list --name server --format json
pnpm --filter payments-worker exec wrangler secret list --name gatopago-payments-api --format json
vercel env ls production --scope danelerrs-projects
git check-ignore -v server/.dev.vars contracts/.env client/.env dashboard/.env.local
```

Para comprobar el árbol versionado:

```powershell
gitleaks git --redact --verbose .
gitleaks dir --config .gitleaks-worktree.toml --redact --verbose .
```

El segundo scan tiene excepciones explícitas para almacenes locales ignorados;
por eso no demuestra que la carpeta de OneDrive esté libre de secretos. El
inventario de existencia anterior se debe revisar además del scanner.

En la verificación del 25-08-2026 Gitleaks no estaba instalado, por lo que esos
dos comandos no se pudieron ejecutar localmente. Como control compensatorio se
escanearon 895 archivos de texto tracked/untracked-no-ignored sin imprimir
matches: cero hallazgos de alta confianza y cero asignaciones sensibles no
vacías en `.env.example`/`.dev.vars.example`. También se revisaron 70 commits:
el único patrón fue la API key web pública de Firebase en versiones históricas
de `client/.env`. El workflow de GitHub conserva el gate Gitleaks completo para
la próxima ejecución remota; este control compensatorio no pretende sustituirlo.

## Prohibiciones

- No copiar todos los Secrets de App a Payments ni viceversa.
- No colocar secretos en `wrangler.jsonc`, `VITE_*`, `.env.example`, manifests,
  screenshots, tickets, logs o argumentos de CLI.
- No reutilizar `wallet-0x75` ni una contraseña vacía para mainnet.
- No considerar `.gitignore` un gestor de secretos.
- No borrar/revocar una clave anterior antes de comprobar la migración que
  depende de ella.
- No afirmar que el valor remoto procede de un archivo local si sólo coincide
  el nombre.

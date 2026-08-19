# Runbook - Poner GatoPago a funcionar en Arbitrum

> Orden exacto para activar todo lo implementado (contratos V2, ledger D1,
> indexación dirigida por eventos, swaps, referidos) en **Arbitrum Sepolia**. Al final, el delta
> para **Arbitrum One**.


## 1. Claves y fondos (una sola vez)

Cinco roles básicos (pueden ser la misma clave en testnet, pero mejor no):

| Rol | Para qué | Necesita |
|---|---|---|
| **Deployer** (tu keystore `wallet-0x75`) | Desplegar contratos + stake/deposit del paymaster | ~0.05 ETH en Arbitrum Sepolia |
| **Relayer** (`PRIVATE_KEY` del worker) | `handleOps`, crear cuentas y CCTP | ~0.05 ETH en las redes donde envía transacciones |
| **Faucet** (`FAUCET_PRIVATE_KEY`) | Custodiar y transferir el presupuesto de bienvenida | ETH para gas **+ USDC de prueba** |
| **Paymaster signer** (`PAYMASTER_SIGNER_PRIVATE_KEY`) | Firmar patrocinios de gas | Nada (solo firma) |
| **Recovery guardian** (`RECOVERY_GUARDIAN_PRIVATE_KEY`) | Proponer/cancelar recovery con timelock | ETH para sus transacciones |

```bash
# Generar las claves nuevas que falten
cast wallet new   # relayer
cast wallet new   # faucet
cast wallet new   # paymaster signer
```

Fondos: ETH de Sepolia → bridge a Arbitrum Sepolia (o faucet de Arbitrum);
USDC de prueba para el **faucet** en https://faucet.circle.com (red: Arbitrum Sepolia).

## 2. Desplegar contratos (CREATE2 determinista)

```bash
cd contracts
forge script script/Deploy.s.sol:DeployV2 \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
  --account wallet-0x75 \
  --sender 0x75464f762bc50d0A0B127ab5a085504BF102Bb88 \
  --broadcast
```

**`--sender` es obligatorio** (la dirección de `wallet-0x75`). Sin él,
`msg.sender` es el DefaultSender de Foundry y la política compartida aborta antes
de emitir transacciones. En testnet, si no defines variables `GATOPAGO_*`, el
deployer queda como owner/sponsor por simplicidad.

El summary imprime `verifier / factory / paymaster`. **Anótalos.**
(El script ya hace `addStake` 0.001 ETH, `deposit` 0.01 ETH y fija el cap de gas
patrocinado por op `setMaxSponsoredGasCost(0.005 ether)` del paymaster.)

> Nota (jul-2026): las fuentes de los contratos avanzaron respecto de lo
> desplegado en Sepolia — router con `payInvoiceWithPermit`, recovery validada +
> cancel del guardian, paymaster con cap de gas, `SIG_VALIDATION_FAILED` y ciclo
> de stake (`unlockStake`/`withdrawStake`; la instancia vieja NO los tiene: su
> stake de 0.001 ETH es costo hundido). Un redeploy cambia las direcciones
> CREATE2 → actualizar `shared/networks.ts` (+ flag `paymentRouterHasPermit`) y
> re-correr `setTokenSupported`. Detalle en `contracts/AUDIT.md`.

En **testnet no necesitas** `setSponsorSigner`: el constructor deja al deployer
como signer. En mainnet el script exige `GATOPAGO_PAYMASTER_SIGNER`, lo configura
antes de terminar y emite `SponsorSignerSet` (ver §11).

## 3. Verificar contratos (Sourcify - sin API key)

Opcional pero recomendado: publica el código fuente para inspeccionar e
interactuar con los contratos desde el explorador. `forge verify-contract` usa
**Sourcify por defecto** (no requiere API key) y `--watch` espera hasta confirmar
`Status: exact_match`.

Usa las direcciones del summary del paso 2 y verifica **en este orden** (el
verifier y la implementación no llevan constructor-args; factory y paymaster sí):

```bash
cd contracts

# 1. Verifier WebAuthn (sin constructor-args)
forge verify-contract <VERIFIER> src/ERC7913WebAuthnVerifier.sol:ERC7913WebAuthnVerifier \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch

# 2. Implementación de la smart account (sin constructor-args)
forge verify-contract <ACCOUNT_IMPL> src/AccountWebAuthnV2.sol:AccountWebAuthnV2 \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch

# 3. Factory - constructor: la dirección de la implementación
forge verify-contract <FACTORY> src/AccountFactoryV2.sol:AccountFactoryV2 \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch \
  --constructor-args $(cast abi-encode "constructor(address)" <ACCOUNT_IMPL>)

# 4. Paymaster - constructor: EntryPoint + owner (= el --sender del deploy)
forge verify-contract <PAYMASTER> src/ParmeliaPaymaster.sol:ParmeliaPaymaster \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch \
  --constructor-args $(cast abi-encode "constructor(address,address)" \
    0x433709009B8330FDa32311DF1C2AFA402eD8D009 <DEPLOYER>)
```

Notas:
- Los `--constructor-args` deben coincidir **exacto** con los del deploy. En el
  paymaster, el 2º arg es el owner = tu `--sender` (`wallet-0x75`); si pones otra
  dirección la verificación falla (`bytecode mismatch`).
- `$(cast abi-encode ...)` es sintaxis de bash (Git Bash); funciona tal cual.
- Verificar es idempotente: re-correrlo sobre un contrato ya verificado responde
  "already verified".
- ¿Prefieres **Arbiscan** en vez de Sourcify? Añade
  `--verifier etherscan --etherscan-api-key <API_KEY>` (requiere cuenta Arbiscan).
  Sourcify basta para leer/interactuar y no pide key.

## 4. Rellenar direcciones en `shared/networks.ts`

En `NETWORKS["arbitrum-sepolia"].contracts` reemplaza los `TODO_DEPLOY`:
`factory`, `paymaster`, `verifier` (los del paso 2). EntryPoint y USDC ya están.

> **Desplegado en Arbitrum Sepolia (redeploy endurecido, 5-jul-2026):**
> | Contrato | Dirección |
> |---|---|
> | verifier  | `0x14D5D46fc6ED1154F3719f87ae72C3020d4fb886` |
> | impl      | `0xDFA9df7d6CCc3b92F8a8e245D6E9760c3346184C` |
> | factory   | `0xb97E923E27CB258012081446e4b436afd3974108` |
> | paymaster | `0x913a1B51c4f5b1a458A56D0d700c956834cc1d15` |
> | paymentRouter | `0xaF5a6856F65eab6bd8d0e403E4cFd49aD0c0c04f` (con permit; USDC habilitado, min 1 USDC) |
> | crosschainRouter | `0x88Ae8A42d004934cD72b534bd362A49e7E4ad3a1` |
>
> Generación anterior (jun-2026, cuentas existentes siguen operativas):
> verifier `0xb7fA10dE…06d6`, impl `0xa450bc49…527e`, factory
> `0x75c7761d…EDEB`, paymaster `0x31f357a6…5753` (stake hundido; el
> depósito de gas es recuperable con `withdrawTo`), paymentRouter
> `0x607fF0c2…975A`, crosschainRouter `0x0816d133…D777`.
>
> La `impl` no va en `networks.ts` (la factory ya la referencia); solo se usó para
> verificar. Si re-despliegas con distinto bytecode (cambio de `foundry.toml` o de
> contratos), estas direcciones cambian.

## 5. Base de datos remota (migraciones)

### Preflight obligatorio: bookmark, backup y restore drill

[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
mantiene recuperación punto-en-tiempo automáticamente, pero su retención es
limitada. Antes de cada migración remota, captura el bookmark y un
[export SQL](https://developers.cloudflare.com/d1/best-practices/import-export-data/)
cifrado de largo plazo con una clave estable guardada en el gestor de secretos
del operador (no es un secret del Worker y nunca va al repositorio):

```powershell
$env:D1_BACKUP_ENCRYPTION_KEY = "<32 bytes en hex o base64>"
$env:D1_BACKUP_ENCRYPTION_KEY_ID = "archivo-2026-07"
pnpm d1:backup
```

El comando obtiene primero el bookmark actual de Time Travel, ejecuta
`wrangler d1 export --remote`, cifra el SQL en streaming con AES-256-GCM,
calcula hashes de plaintext/ciphertext, restaura una copia local aislada y exige
`PRAGMA quick_check`, `foreign_key_check` y las tablas críticas. Sólo entonces
conserva `backups/parmeliadb-<fecha>.sql.enc` y su manifest. El export remoto
bloquea consultas mientras corre: programarlo en una ventana de bajo tráfico.

Verifica de nuevo un archivo histórico antes de usarlo:

```powershell
node scripts/d1-backup.mjs --verify backups/parmeliadb-<fecha>.sql.enc
```

Para una recuperación fuera de la ventana de Time Travel, descifra a una ruta
protegida, importa el SQL en una **D1 nueva**, valida la aplicación y cambia el
binding. No importes el dump encima de una base con tablas existentes:

```powershell
node scripts/d1-backup.mjs --decrypt backups/parmeliadb-<fecha>.sql.enc --output C:\secure\parmeliadb-recovery.sql
```

Para errores recientes, usa preferentemente el bookmark registrado con
`wrangler d1 time-travel restore`; es destructivo sobre la D1 activa y cancela
queries en vuelo, por lo que exige aprobación operativa y comprobación posterior.
Antes de desplegar, ejecuta localmente `pnpm check:d1:restore`; usa dos bases
locales desechables para ensayar todo el formato cifrado y la restauración.

```bash
cd server
npx wrangler d1 migrations apply GATOPAGO_DB --remote
```

No confíes en una lista manual para conocer el estado remoto. Ejecuta primero
`npx wrangler d1 migrations list GATOPAGO_DB --remote` y aplica, en orden, todo
lo que falte hasta `0026_indexer_work_partitions.sql`. El Worker actual requiere
la cadena completa: además del hardening y los ciclos durables originales,
`0012`-`0026` incorporan journal canónico, read models de Home, evidencia y
rollback de reorg, shards del indexador, suscripciones de proveedor, control
plane RPC, finality de Arbitrum, outboxes, ciclo durable de UserOperations,
paginación del ledger, cache durable de capacidades del bundler, cola de
reconciliación, auditorías de balance y registro incremental de wallets.
REGLA: migraciones SIEMPRE antes del `wrangler deploy` del Worker que las usa.
El prólogo `DROP` de `0001` fue una decisión de testnet (datos desechables);
nunca replicar ese patrón hacia producción.

### Reserva de nonce bloqueada

`GET /health` devuelve `503` con `signer_nonce_blocked` si una operación queda
en `needs_review`. Es intencional: continuar firmando podría reemplazar una
transacción cuyo nonce ya fue consumido.

1. Consulta la fila en D1 (`id`, `tx_hash`, `signer_address`, `nonce`,
   `raw_transaction`, `last_error`).
2. Comprueba el receipt por `tx_hash` y `eth_getTransactionCount` del firmante
   en `latest` y `pending`, usando al menos dos RPCs.
3. Si minó, ejecuta/repara la finalización idempotente antes de marcarla
   terminal. Si no minó y el nonce sigue libre, reemite **la misma**
   `raw_transaction`.
4. No borres ni cambies la fila para “desbloquear” sin demostrar el estado
   on-chain; documenta la resolución y conserva el hash para auditoría.

## 6. Secrets del worker

```bash
cd server
npx wrangler secret put RPC_URL          # compatibilidad; no mezclar roles nuevos aquí
npx wrangler secret put RPC_READ_URLS    # pool de lecturas puntuales
npx wrangler secret put RPC_WRITE_URLS   # broadcast/simulación crítica
npx wrangler secret put RPC_INDEXER_URLS # pool canónico eth_getLogs
npx wrangler secret put RPC_ARCHIVE_URLS # backfills aislados, si se habilitan
npx wrangler secret put RPC_PROVIDER_CAPABILITIES # límites/prioridad por endpoint
npx wrangler secret put PRIVATE_KEY                        # relayer handleOps/CCTP
npx wrangler secret put FAUCET_PRIVATE_KEY                 # fondos del faucet (mainnet: obligatoria si se activa)
npx wrangler secret put RECOVERY_GUARDIAN_PRIVATE_KEY      # guardian (mainnet: obligatorio y distinto)
npx wrangler secret put PAYMASTER_SIGNER_PRIVATE_KEY       # firma sponsorships
npx wrangler secret put PAYMENT_ROUTER_SIGNER_PRIVATE_KEY  # firma invoices Flow B
# Opcionales en TESTNET (feature-flag). En MAINNET: TURNSTILE es OBLIGATORIO
# (sin el, /account/create y /account/fund fallan cerrado) y las claves
# dedicadas de arriba tambien (los fallbacks entre claves estan prohibidos).
npx wrangler secret put TURNSTILE_SECRET_KEY           # anti-abuso en crear cuenta + faucet
Get-Content -Raw ..\<service-account>.json | npx wrangler secret put FCM_SERVICE_ACCOUNT  # push
npx wrangler secret put CCTP_RPC_URLS                  # opcional: RPCs dedicados cross-chain
npx wrangler secret put ALCHEMY_WEBHOOK_ID             # Address Activity
npx wrangler secret put ALCHEMY_WEBHOOK_NETWORK        # red exacta del webhook
npx wrangler secret put ALCHEMY_WEBHOOK_SIGNING_KEY    # HMAC Address Activity
npx wrangler secret put ALCHEMY_ADDRESS_WEBHOOKS_JSON  # reemplazo multi-slot opcional
npx wrangler secret put ALCHEMY_NOTIFY_AUTH_TOKEN      # API Notify; no es la key RPC
npx wrangler secret put ALCHEMY_CUSTOM_WEBHOOK_ID      # eventos de router/recovery
npx wrangler secret put ALCHEMY_CUSTOM_WEBHOOK_SIGNING_KEY
npx wrangler secret put WEBHOOK_SECRET_ENCRYPTION_KEY  # 32 bytes base64/hex; obligatorio en mainnet
npx wrangler secret put WEBHOOK_SECRET_ENCRYPTION_KEY_ID # ID corto, por ejemplo 2026_07
```

`GET /health` devuelve `200` sólo si la configuración es coherente. En mainnet,
el Worker responde/falla cerrado con `503 SERVICE_UNAVAILABLE` si
faltan contratos, CORS HTTPS, Turnstile, APP_URL, cifrado o claves dedicadas. Las
cuentas activas de relayer, faucet, paymaster, invoices y guardian deben ser distintas.

### Rotación de la clave de webhooks

1. Conserva temporalmente la clave anterior en
   `WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS`, como JSON `{"id_viejo":"clave"}`.
2. Carga la clave nueva en `WEBHOOK_SECRET_ENCRYPTION_KEY` y cambia
   `WEBHOOK_SECRET_ENCRYPTION_KEY_ID` a un ID nuevo.
3. Despliega. El job de rotación descifra con la clave anterior y recifra gradualmente en
   formato `enc:v2:<id_nuevo>`, usando compare-and-set para no pisar ediciones.
4. Comprueba que no queden filas antiguas y elimina
   `WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS` con `wrangler secret delete`.

No retires la clave previa antes del paso 4: las entregas de esos endpoints no
podrían firmarse.

Ya configurado en `wrangler.jsonc`: `CHAIN_KEY=arbitrum-sepolia`,
`ALLOWED_ORIGINS`, una Queue y `EventJobScheduler`. No hay Cron Trigger: el
Durable Object conserva una alarma sólo mientras exista trabajo y la elimina al
vaciarse. El consumidor usa `max_batch_size=1`, de modo que cada
indexador/reconciliador recibe una invocación y un presupuesto de subrequests
independiente. Configura `APP_URL`, flags cross-chain y fees (`GATOPAGO_*`)
explícitamente para cada entorno; mainnet no acepta el fallback de `APP_URL`.

### RPC: capacidades por endpoint

El Worker separa lecturas, escrituras, indexación y archivo. Cada rol admite un
pool y `RPC_URL` queda sólo como fallback de compatibilidad:

| Rol | Uso |
|---|---|
| `RPC_READ_URLS` | balances puntuales, receipts y llamadas de contrato |
| `RPC_WRITE_URLS` | simulación y broadcast |
| `RPC_INDEXER_URLS` | `eth_getLogs` del journal y reconciliadores |
| `RPC_ARCHIVE_URLS` | backfill histórico aislado |
| `BUNDLER_RPC_URLS` | métodos ERC-4337; no equivale a un Node RPC |

Los planes no se codifican por hostname. En
`RPC_PROVIDER_CAPABILITIES`, cada posición declara ID seguro, prioridad,
concurrencia y rango:

```json
{
  "indexer": [
    { "id": "managed", "priority": 0, "maxConcurrency": 4, "maxLogRange": 10 },
    { "id": "public", "priority": 1, "maxConcurrency": 2, "maxLogRange": 2000 }
  ]
}
```

Así ambos endpoints pueden coexistir. Una consulta de 2.000 usa sólo un
proveedor elegible; una de 10 intenta por prioridad. Si falla el proveedor
grande, el scanner reduce el span hasta que otro sea elegible. El checkpoint
sólo avanza después de persistir journal y proyecciones.

`RpcAdmissionController` impone `maxConcurrency` globalmente por endpoint/lane,
además del semáforo local y circuit breaker. Subir o bajar de plan cambia la
configuración, no el indexador. Antes de promover:

```powershell
$env:CHAIN_KEY = "arbitrum-sepolia"
$env:RPC_INDEXER_URLS = "<ENDPOINT_1>,<ENDPOINT_2>"
$env:RPC_PROVIDER_CAPABILITIES = '{"indexer":[...]}'
pnpm check:rpc-indexer
```

Una API key expuesta en captura, terminal o ticket se rota antes de habilitar el
endpoint. La clave del Node RPC va dentro de la URL y por eso se carga como
secret. Para Address Activity también hacen falta
`ALCHEMY_WEBHOOK_SIGNING_KEY`, `ALCHEMY_WEBHOOK_ID` y
`ALCHEMY_NOTIFY_AUTH_TOKEN`; este último es el token de Notify y **no** la API
key del Node RPC.

### Alchemy Notify (para cero polling permanente)

La URL RPC de Node no activa Notify. Crea dos webhooks en Alchemy:

Nunca reutilices una Node API key que haya aparecido en una captura o chat:
rótala primero. Notify usa además signing keys y un auth token propios; mantener
los dos flags en `false` es el modo seguro mientras falten esas credenciales.

1. **Address Activity** → `https://server.parmelia.workers.dev/ingest/alchemy`.
   Guarda su ID, network, signing key y el token de administración Notify en los
   secrets `ALCHEMY_WEBHOOK_*`/`ALCHEMY_NOTIFY_AUTH_TOKEN`, o usa
   `ALCHEMY_ADDRESS_WEBHOOKS_JSON` para varios slots. Luego cambia
   `ALCHEMY_WEBHOOK_ENABLED` a `true`. GatoPago sincroniza las wallets nuevas en
   ese webhook y vuelve a leer cada bloque con el pool `RPC_INDEXER_URLS`. El
   primer inventario remoto se pagina y persiste; después sólo se envían diffs
   de hasta 500 direcciones contra un espejo D1. Las señales de actividad
   solicitan además un balance canónico de la wallet para cubrir ETH nativo.
2. **Custom Webhook (GraphQL)** →
   `https://server.parmelia.workers.dev/ingest/alchemy/custom`. Filtra
   exclusivamente las direcciones y topics de `InvoicePaid` del
   `ParmeliaPaymentRouter` y de los eventos de recovery de
   `AccountWebAuthnV2`; no uses un stream de todos los logs. Guarda ID y signing
   key, y cambia `ALCHEMY_CUSTOM_WEBHOOK_ENABLED` a `true`.

El Custom Webhook es una señal de despertar, no la fuente de verdad: los
watchers vuelven a leer por el pool RPC antes de mutar D1. Los topics conocidos
se enrutan sólo al stream/shard afectado; un esquema desconocido usa fallback
conservador. En testnet
puede quedar apagado; sólo mientras exista un invoice activo habrá un fallback
acotado cada dos minutos. En mainnet la validación exige el Custom Webhook.

Consola Firebase (para login por correo/Apple, push y analytics): habilitar
Email link (y Apple si aplica), activar account-linking "same email", generar la
VAPID y el service account, y habilitar GA4. Detalle paso a paso en `INTEGRACIONES.md`.

## 7. Desplegar el Worker manualmente (registra DO y consumers)

Todo el flujo se ejecuta desde la máquina del operador. No despliegues si falla
alguno de estos pasos:

```powershell
# 1. Validación completa local.
pnpm verify:all

# 2. Backup remoto cifrado y restore drill.
$env:D1_BACKUP_ENCRYPTION_KEY = "<32 bytes en hex o base64>"
$env:D1_BACKUP_ENCRYPTION_KEY_ID = "archivo-2026-07"
pnpm d1:backup

# 3. Revisar y aplicar migraciones antes del Worker.
pnpm --filter server exec wrangler d1 migrations list GATOPAGO_DB --remote
pnpm --filter server exec wrangler d1 migrations apply GATOPAGO_DB --remote

# 4. Sólo en la primera instalación: comprobar y crear las Queues declaradas.
pnpm --filter server exec wrangler queues list
# Si no existen:
# pnpm --filter server exec wrangler queues create parmelia-scheduled-jobs
# pnpm --filter server exec wrangler queues create parmelia-scheduled-jobs-dlq

# 5. Regenerar bindings y validar el bundle/config sin publicar.
pnpm --filter server cf-typegen:check
pnpm --filter server exec wrangler deploy --dry-run --minify

# 6. Desplegar la fuente local verificada. Wrangler registra también la
# migración v2 de RpcAdmissionController declarada en wrangler.jsonc.
# Wrangler ejecuta `forge build` automáticamente para regenerar los ABIs que
# consume `shared/index.ts`, incluso si `contracts/out` fue limpiado.
$releaseSha = git rev-parse HEAD
pnpm --filter server exec wrangler deploy --minify --keep-vars --strict `
  --message "manual $releaseSha"

# 7. Exigir readiness saludable.
$health = Invoke-RestMethod -Uri "https://server.parmelia.workers.dev/health"
if ($health.status -ne "ok" -or $health.issues.Count -ne 0) {
  throw "El Worker desplegado no está saludable"
}
```

Mueve el backup cifrado a almacenamiento protegido fuera del workspace. El
despliegue usa las credenciales locales de Wrangler y los secrets ya guardados
en Cloudflare; nunca copies sus valores a comandos, documentación o Git.

### Rollback del Worker

Si el healthcheck falla o aparece una degradación, identifica el version ID
anterior y revierte explícitamente. Las migraciones actuales son aditivas y
**no** se revierten con el Worker; no las deshagas a ciegas. Para daño de datos
usa primero el bookmark Time Travel o el backup cifrado pre-deploy descrito en
la sección 5.

```bash
cd server
pnpm exec wrangler versions list
pnpm exec wrangler rollback <VERSION_ID_ANTERIOR> --message "rollback <INCIDENTE>" --yes
```

## 8. Cliente

**Local** - `client/.env` (ya con `VITE_CHAIN_KEY=arbitrum-sepolia`). Añade las
de integraciones cuando las tengas:
```
VITE_SERVER_URL=https://server.parmelia.workers.dev
VITE_TURNSTILE_SITE_KEY=...        # site key de Turnstile (pública)
VITE_FIREBASE_VAPID_KEY=...        # VAPID pública (web push)
VITE_FIREBASE_MEASUREMENT_ID=...   # G-XXXX cuando habilites GA4
```
```bash
pnpm --filter client dev
```

**Producción (Vercel)** - la raíz del repositorio está enlazada al proyecto
existente `danelerrs-projects/parmelia`; `vercel.json` construye únicamente
`client` y publica `client/dist`. Las variables `VITE_*` viven en el entorno
Production del proyecto. Desde la raíz:

```bash
vercel --prod
```

Ese comando actualiza `app.parmelia.me`; no debe crear ni enlazar otro proyecto.

## 9. Smoke test (en orden)

```bash
pnpm --filter server test:unit           # 165 tests Node
pnpm --filter server test:worker-runtime # 17 tests workerd + D1 real
cd contracts && forge test       # 124 tests unitarios
pnpm --filter server exec wrangler tail server # dejar abierto para ver logs
```

En la app:
1. Login → Onboarding → crear cuenta (passkey). ✓ wallet creada + **5 USDC de bienvenida** (si falla, al relayer le falta USDC/ETH).
2. Crear link de cobro → pagarlo desde una segunda cuenta. ✓ ambos lados aparecen en Actividad/Extractos (ledger).
3. `/swap`: cotizar USDC/ETH. Nota: en Sepolia puede no haber liquidez v3/v4 ("sin ruta disponible" es esperado); el flujo completo se valida en One.
4. En `wrangler tail`, después de crear la wallet esperar
   `event_jobs_dispatched`, seguido por `indexer_run` y `event_job_completed`.
   `indexer_run` debe incluir `finalitySource` (`safe` o `confirmations`) y un
   `unconfirmedBlocks` acotado; un crecimiento sostenido indica RPC degradado.
5. Enviar USDC a la wallet desde una EOA externa. Con Address Activity aparece
   al llegar el webhook; sin él, abrir Home stale despierta el backfill y lo
   recupera. Esperar dos minutos sin actividad ya no es una prueba válida.
6. Contactos: copiar tu código, abrir `localhost:5173/?ref=CODIGO` en incógnito, crear cuenta → el contador sube.

## 10. Delta para Arbitrum One (cuando toque)

1. Exporta todas las direcciones de rol de §11 y ejecuta el mismo `forge script`
   con `--rpc-url https://arb1.arbitrum.io/rpc` y `--sender <DEPLOYER>`. Verifier,
   implementación y factory conservan direcciones CREATE2 si el bytecode no
   cambió; routers con argumentos de rol distintos tendrán direcciones distintas.
2. `CHAIN_KEY=arbitrum-one` en `wrangler.jsonc` + secrets de mainnet (RPC, claves fondeadas con ETH real).
3. El faucet queda apagado por defecto. Para activarlo deliberadamente configura `FAUCET_ENABLED=true` y `FAUCET_DAILY_BUDGET_USDC`; sin ambos no mueve USDC real.
4. Activar fees si quieres: `GATOPAGO_FEES_ENABLED=true`, `GATOPAGO_SWAP_FEE_BPS`, `GATOPAGO_TREASURY_ADDRESS`.
5. El bridge (`/depositar`) se activa solo en One; re-verificar las USDC externas contra Circle docs.
6. **Separar las claves de infra** - ver sección 11. Es el cambio más importante para mainnet.
7. Otros pendientes P1 antes de público real: rate limiting de zona, bundler gestionado (#13).

## 11. Consideraciones de seguridad para mainnet (separación de claves)

> **En testnet (Arbitrum Sepolia) se permite usar UNA sola EOA para todo**
> (deployer = relayer = faucet = paymaster signer = guardian, misma `PRIVATE_KEY`).
> Son fondos de prueba: el riesgo es cero y simplifica el setup. Lo de abajo
> **NO aplica al deploy de testnet** - es la lista para endurecer antes de mainnet.

### Por qué importa en mainnet

El broadcaster necesita autoridad temporal para fondear/configurar el Paymaster,
pero no debe conservarla. En Arbitrum One, `DeploymentRoles` falla cerrado si
broadcaster, owner final, treasury o firmantes colisionan. El script configura
el sponsor, inicia `transferOwnership` y deja pendiente la aceptación del owner
final; PaymentRouter y CrosschainRouter nacen directamente con roles separados.

Importante: **los fondos de los usuarios siguen a salvo** pase lo que pase -
moverlos exige su passkey. El daño máximo de una clave de infra comprometida es
gastar el gas/faucet, spamear, o *proponer* un recovery (mitigado por timelock de
48h + cancelación del usuario). Lo que protegemos aquí es el dinero del gas y la
disponibilidad del servicio, no la custodia.

### Setup mínimo de roles separados

| Clave | Rol | Dónde vive | Poder |
|---|---|---|---|
| **Deployer** (`wallet-0x75`) | Sólo broadcast inicial | EOA de despliegue, fuera del Worker | Despliega y configura antes del handoff |
| **Contract owner** | Owner final de Paymaster/routers | Safe/multisig o control frío | Admin, pausa, retiros y rotación |
| **Treasury** | Recibir fees | Custodia separada | Recibe fondos; no administra contratos |
| **Relayer** (nueva) | `PRIVATE_KEY` del worker: `handleOps`, crear cuentas y CCTP | Caliente, en el worker | Gasta ETH operativo |
| **Faucet** (nueva) | `FAUCET_PRIVATE_KEY`: transfiere fondos de bienvenida | Caliente, en el Worker sólo si se activa | Limitada a su ETH/USDC presupuestado |
| **Paymaster signer** (nueva) | `PAYMASTER_SIGNER_PRIVATE_KEY`: firma patrocinios | Caliente, en el worker | Solo firma (sin fondos) |
| **Invoice signer** (nueva) | `PAYMENT_ROUTER_SIGNER_PRIVATE_KEY` | Caliente, en el Worker | Autoriza invoices; no administra |
| **Recovery guardian** (nueva) | `RECOVERY_GUARDIAN_PRIVATE_KEY`: propone/cancela recovery | Secret separado; HSM/MPC recomendado | Recovery con timelock, sin mover fondos directamente |

Pasos:
1. Prepara direcciones distintas y expórtalas antes de simular/broadcast:

   ```bash
   export GATOPAGO_CONTRACT_OWNER=<SAFE_O_ADMIN_FRIO>
   export GATOPAGO_TREASURY=<TESORERIA>
   export GATOPAGO_PAYMASTER_SIGNER=<SIGNER_PAYMASTER>
   export GATOPAGO_PAYMENT_ROUTER_SIGNER=<SIGNER_INVOICES>
   ```

2. Ejecuta los scripts con `--sender <DEPLOYER>`. Omitir una variable o reutilizar
   una dirección en chain `42161` revierte antes del primer broadcast.
3. El owner final ejecuta `acceptOwnership()` sobre el Paymaster (desde Safe si
   corresponde). Hasta entonces el deployer sigue siendo owner actual; no des por
   terminado el despliegue mientras `pendingOwner()` sea distinto de cero.
4. Carga sólo relayer/faucet/paymaster/invoice/guardian en secrets del Worker. Deployer,
   owner y treasury nunca se exponen al runtime.

### Pendientes de hardening (código)

- **Guardian dedicado (#8):** implementado. Mainnet exige `RECOVERY_GUARDIAN_PRIVATE_KEY` distinta de `PRIVATE_KEY`; para producción de alto valor sigue siendo preferible un contrato multisig/MPC/HSM y aprobación humana.
- **Least-privilege (#7):** implementado. `FAUCET_PRIVATE_KEY` firma y reserva su
  propio nonce; mainnet rechaza su ausencia o colisión cuando el faucet está activo.
- **Depósito del paymaster:** el script deja 0.01 ETH; recargar según volumen real.
- **Mismo `foundry.toml`** (solc + optimizer) entre testnet y mainnet para que CREATE2 dé las mismas direcciones.

## 12. Routers opcionales (Payments API Flow B + Cross-chain)

> Scripts en `contracts/script/Deploy.s.sol`: **`DeployPaymentRouter`** y
> **`DeployCrosschainRouter`**. Son independientes del deploy base (§2); el resto
> de la app funciona sin ellos (los endpoints quedan deshabilitados hasta que la
> dirección esté en `shared/networks.ts`). Ambos usan CREATE2 con salt fijo y la
> política fail-closed de roles.

### 12.1 PaymentRouter (Payments API, Flow B - paga cualquier wallet externa)

```bash
cd contracts
forge script script/Deploy.s.sol:DeployPaymentRouter \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
  --account wallet-0x75 \
  --sender 0x75464f762bc50d0A0B127ab5a085504BF102Bb88 \
  --broadcast
```

En testnet el deployer queda como `owner = treasury = invoiceSigner`. En mainnet
define las cuatro variables `GATOPAGO_*` de §11 antes de ejecutar. Después:
1. `cast send <PAYMENT_ROUTER> "setTokenSupported(address,bool,uint256)" <USDC> true <MIN> --account wallet-0x75` (p. ej. `MIN = 1000000` = 1 USDC).
2. Rellenar `contracts.paymentRouter` en `shared/networks.ts` (arbitrum-sepolia).
3. Secrets del worker: `PAYMENT_ROUTER_SIGNER_PRIVATE_KEY` (= la EOA del `invoiceSigner`) y `GATOPAGO_PAYMENT_FEE_BPS`.

### 12.2 CrosschainRouter (cross-chain Flow B outbound - CCTP v2)

Necesita dos env vars: la **USDC** local y el **TokenMessengerV2** de CCTP v2.

```bash
cd contracts
# Arbitrum Sepolia: USDC + CCTP v2 TokenMessenger (verificados, deterministas)
export USDC_ADDRESS=0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d
export CCTP_TOKEN_MESSENGER=0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA
forge script script/Deploy.s.sol:DeployCrosschainRouter \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
  --account wallet-0x75 \
  --sender 0x75464f762bc50d0A0B127ab5a085504BF102Bb88 \
  --broadcast
```

> En PowerShell, en vez de `export`: `$env:USDC_ADDRESS="0x75fa..."; $env:CCTP_TOKEN_MESSENGER="0x8FE6..."`.

En testnet el deployer queda como `owner = treasury`. En mainnet define al menos
`GATOPAGO_CONTRACT_OWNER` y `GATOPAGO_TREASURY`, distintas del broadcaster y
entre sí. Después:
1. Rellenar `contracts.crosschainRouter` en `shared/networks.ts` (arbitrum-sepolia).
2. Secret del worker: `GATOPAGO_CROSSCHAIN_FEE_BPS` (ya existe en `auth.ts`).
3. No hay whitelist de tokens: la USDC es inmutable en el constructor.

> CCTP v2 (verificado): TokenMessengerV2 `0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA`,
> MessageTransmitterV2 `0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275` (mismas en
> Arbitrum y Base Sepolia). Dominios: Arbitrum 3, Base 6. Detalle en `CROSSCHAIN_DESIGN.md` §11.

### 12.3 Verificación (opcional, Sourcify)

```bash
# PaymentRouter - constructor(address owner, address treasury, address signer)
forge verify-contract <PAYMENT_ROUTER> src/ParmeliaPaymentRouter.sol:ParmeliaPaymentRouter \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch \
  --constructor-args $(cast abi-encode "constructor(address,address,address)" <OWNER> <TREASURY> <INVOICE_SIGNER>)

# CrosschainRouter - constructor(address owner, address usdc, address messenger, address treasury)
forge verify-contract <CROSSCHAIN_ROUTER> src/ParmeliaCrosschainRouter.sol:ParmeliaCrosschainRouter \
  --chain 421614 --rpc-url https://sepolia-rollup.arbitrum.io/rpc --watch \
  --constructor-args $(cast abi-encode "constructor(address,address,address,address)" \
    <OWNER> 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d 0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA <TREASURY>)
```

En testnet, `<OWNER>`, `<TREASURY>` e `<INVOICE_SIGNER>` son el deployer salvo
que hayas definido las variables opcionales. En mainnet deben coincidir con los
valores `GATOPAGO_*` usados durante el broadcast.

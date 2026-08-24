# Server (Cloudflare Worker)

API de GatoPago: Hono sobre Cloudflare Workers + D1. Ver `../ARCHITECTURE.md` para el detalle y `../DEPLOY.md` para el runbook de despliegue.

## Desarrollo local

```txt
pnpm install
pnpm --filter server dev      # o: npm run dev
pnpm --filter server lint     # reglas TypeScript + promises type-aware
pnpm --filter server test     # suite Node + integración real en workerd/D1
pnpm --filter server test:unit
pnpm --filter server test:worker-runtime
```

## Despliegue

```txt
npm run deploy
npm run cf-typegen            # regenerar tipos del Worker
npm run cf-typegen:check      # falla si el archivo generado tiene drift
```

La suite `test:worker-runtime` usa `wrangler.test.jsonc` y el sentinel no
sensible `.dev.vars.runtime-test`; nunca carga `.dev.vars`. Aplica las once
migraciones originales más todas las migraciones aditivas hasta `0026` sobre un
D1 aislado y prueba HTTP, CORS, Web Crypto, límites de body,
FK/STRICT, operaciones de cuenta durables y exclusión de leases dentro
del runtime `workerd`.

Los logs de aplicación son JSON estructurado y pasan por `services/logger.ts`,
que limita mensajes y redacta credenciales, campos secretos y datos sensibles
de URLs. `pnpm check:server-console` bloquea usos directos de `console.*` fuera
de esa implementación.

Cada request recibe un `requestId` único y estable, expuesto en
`X-Request-Id` y reutilizado en logs y errores. Las integraciones HTTP externas
tienen timeout, lectura JSON acotada y liberan bodies ignorados.

## Ejecución dirigida por eventos

El Worker no tiene `scheduled()` ni un Cron Trigger. `EventJobScheduler`, un
Durable Object nombrado por red, job y partición, conserva como máximo una
ejecución pendiente por shard y arma una alarma sólo cuando existe trabajo
durable. Al vencer, publica el job en `parmelia-scheduled-jobs`; el consumidor
toma un lease D1, ejecuta el trabajo y programa otra alarma únicamente si D1
demuestra que el estado sigue activo. Particiones distintas no comparten un
singleton y escalan con la concurrencia configurada de Queue.

Los productores son transiciones reales: una wallet o pago recién creado, una
operación de cuenta/cross-chain pendiente, una fila de outbox, una solicitud de
balance, un webhook firmado de Alchemy o una entrega fallida. Mil solicitudes
equivalentes se compactan por partición; mil Homes del mismo usuario compactan
además su bootstrap de balance en una fila D1 y un job. El registro procesa sólo
wallets nuevas/modificadas y los lectores trabajan por shards estables, no con
un mensaje de Queue por wallet ni cargando todos los usuarios.

`indexer_safety_sweep` es el fallback de corrección: mientras haya al menos una
wallet activa conserva una sola alarma global, consulta el head `safe` cada
`INDEXER_SAFETY_SWEEP_SECONDS` y agenda exclusivamente checkpoints atrasados
más una reconciliación de balances acotada por shard. No depende de Home ni de
Alchemy. **Invariante idle:** con cero wallets activas y sin estado pendiente no
hay alarma, Queue, invocación background ni RPC. `/health` puede reparar una
agenda perdida si encuentra trabajo o shards activos; debe consultarse una vez
después del primer deploy que incorpora el barrido para armar su alarma inicial.

Mientras `ALCHEMY_CUSTOM_WEBHOOK_ENABLED=false`, sólo un invoice on-chain
activo mantiene un fallback de `router_watcher` cada dos minutos; se detiene al
pagarse, cancelarse o expirar el último intent. En mainnet el Custom Webhook es
obligatorio y ese polling desaparece.

## Almacenamiento (D1)

Toda la data de la app vive en D1 (binding `GATOPAGO_DB`): usuarios/usernames, wallet del usuario, `credential_id` (pista de UX), `referral_code`, estado del faucet, links de cobro, pagos pendientes (`prepare`↔`submit`), operaciones on-chain durables de cuenta/faucet/recovery, cotizaciones de swap, contactos y el **ledger** unificado de movimientos.

### Historial = journal + proyecciones D1

`/user/transactions` lee **solo** la tabla `ledger`:

- Lo que la app relaya (pagos, swaps, faucet) se escribe al confirmar - ambos lados en transferencias internas.
- Los **depósitos externos** entrantes los ingiere una sola vez el watcher
  particionado (`services/indexer.ts`) en rangos adaptativos, los guarda con
  bloque/hash/posición en el journal y proyecta el ledger idempotentemente.
- Alchemy Address Activity entrega depósitos de wallets registradas; cada
  payload sólo despierta los shards afectados; el pool RPC vuelve a leer la
  evidencia canónica antes de proyectarla. El mismo payload solicita una
  reconciliación Multicall acotada para cubrir también ETH nativo. Si el webhook
  no llega, el barrido autónomo retoma los shards desde sus checkpoints aunque
  nadie abra la app. Home sólo acelera datos faltantes. La snapshot stale se
  sirve honestamente y nunca existe un refresh global sin particionar.

No depende de Blockscout/Etherscan/BlockVision en cada request.

### Migraciones

```txt
npx wrangler d1 migrations apply parmeliadb --local
npx wrangler d1 migrations apply parmeliadb --remote
```

`0001_schema.sql` es el esquema consolidado (con prólogo `DROP`, **solo aceptable sobre una DB de testnet** — nunca replicar ese patrón en migraciones para producción; las siguientes migraciones son aditivas o rebuilds copy-swap sin pérdida). Nuevas features = nueva migración numerada. **Orden de deploy:** listar y aplicar todas las migraciones hasta `0027_indexer_consistency.sql` ANTES de desplegar el Worker que las usa.

**Ciclo de vida de un pago (`pending_payments.status`):** `prepared → submitting → submitted → confirmed | failed`. Cada transición es un compare-and-set atómico (un doble submit recibe 409 `PAYMENT_IN_PROGRESS`), el tx se registra inmediatamente después del broadcast y `/pay/submit` devuelve 202 sin mantener el request abierto. El éxito se decide por el **`UserOperationEvent` del EntryPoint** (no por `receipt.status`, que solo refleja el bundle: una ejecución interna revertida minaría igual). La contabilidad vive en `services/settlement.ts` (idempotente). El **watcher compartido** resuelve todos los `UserOperationEvent` mediante rangos acotados del indexador —no hace una búsqueda histórica por pago— y el reconciliador durable consulta esa proyección en D1. Sólo entonces liquida o marca `failed`, repara el hand-off CCTP y expira lo que ya no puede aterrizar. `GET /pay/status/:userOpHash` expone el estado para polling.

**Ciclo de vida de cuenta/faucet/recovery (`account_operations.status`):**
`prepared → submitted → confirmed | failed | needs_review`. El Worker firma y
persiste la transacción cruda y su nonce **antes** del broadcast, protegido por
un lease D1 por firmante. Las rutas devuelven 202; el cliente consulta
`GET /account/operations/:id` y un job durable reemite la misma transacción y reconcilia
el recibo. La finalización D1 es idempotente; un revert del faucet libera claim
y presupuesto, mientras `needs_review` bloquea otro envío del mismo tipo. El
mismo lease `chainId + signer` coordina `handleOps`, mints CCTP y operaciones de
cuenta; una reserva raw `prepared/needs_review` bloquea el firmante completo
hasta reconciliar, evitando reemplazos silenciosos de nonce. `/health` devuelve
503 y un contador de incidencias mientras exista una ambigüedad o no pueda
comprobar D1; los códigos concretos sólo aparecen en `/health/ops` autenticado.

## Secrets y variables

`vars` (en `wrangler.jsonc`) para config no sensible: `FIREBASE_PROJECT_ID`, `CHAIN_KEY`, `ALLOWED_ORIGINS`, `APP_URL`, las de fees (`GATOPAGO_*`) y los flags cross-chain (`CROSSCHAIN_PAUSED`, `CROSSCHAIN_DISABLED_CHAINS`, `CROSSCHAIN_MIN_RELAYER_GAS_WEI`).

`wrangler secret put` (o `.dev.vars` local, gitignored) para lo sensible:

```txt
npx wrangler secret put RPC_URL                          # compatibilidad/base
npx wrangler secret put RPC_READ_URLS                    # pool de lecturas puntuales
npx wrangler secret put RPC_WRITE_URLS                   # simulación/broadcast
npx wrangler secret put RPC_INDEXER_URLS                 # pool canónico eth_getLogs
npx wrangler secret put RPC_ARCHIVE_URLS                 # backfills aislados
npx wrangler secret put RPC_PROVIDER_CAPABILITIES        # límites/priority por slot, sin URLs
npx wrangler secret put BUNDLER_RPC_URLS                 # sólo si RELAYER_MODE=bundler
npx wrangler secret put PRIVATE_KEY                       # EOA operativa: relayer handleOps/CCTP
npx wrangler secret put FAUCET_PRIVATE_KEY                # EOA con presupuesto faucet (obligatoria si se activa en mainnet)
npx wrangler secret put RECOVERY_GUARDIAN_PRIVATE_KEY     # guardian dedicado (obligatorio y distinto en mainnet)
npx wrangler secret put PAYMASTER_SIGNER_PRIVATE_KEY      # firma sponsorships del paymaster
npx wrangler secret put PAYMENT_ROUTER_SIGNER_PRIVATE_KEY # firma autorizaciones de PaymentRouter (Flow B)
npx wrangler secret put OPS_HEALTH_TOKEN                  # 32+ caracteres; protege /health/ops
npx wrangler secret put TURNSTILE_SECRET_KEY              # anti-abuso (testnet: opcional; MAINNET: obligatorio, sin él create/fund fallan cerrado)
npx wrangler secret put FCM_SERVICE_ACCOUNT               # JSON del service account, 1 línea (opcional; sin definir = sin push)
npx wrangler secret put CCTP_RPC_URLS                     # opcional: JSON chainId->RPC para destinos cross-chain (si no, públicos)
npx wrangler secret put ALCHEMY_WEBHOOK_ID                # Notify Address Activity
npx wrangler secret put ALCHEMY_WEBHOOK_NETWORK           # red exacta del webhook
npx wrangler secret put ALCHEMY_WEBHOOK_SIGNING_KEY       # firma HMAC de Address Activity
npx wrangler secret put ALCHEMY_ADDRESS_WEBHOOKS_JSON     # reemplazo multi-slot opcional
npx wrangler secret put ALCHEMY_NOTIFY_AUTH_TOKEN         # API Notify para sincronizar wallets
npx wrangler secret put ALCHEMY_CUSTOM_WEBHOOK_ID         # Custom Webhook para router/recovery
npx wrangler secret put ALCHEMY_CUSTOM_WEBHOOK_SIGNING_KEY # firma HMAC del Custom Webhook
npx wrangler secret put WEBHOOK_SECRET_ENCRYPTION_KEY     # 32 bytes base64/hex; AES-GCM para secretos HMAC (mainnet obligatorio)
npx wrangler secret put WEBHOOK_SECRET_ENCRYPTION_KEY_ID  # identificador corto de la clave activa
npx wrangler secret put WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS # JSON id->clave, sólo durante rotación
```

La API key incluida en una URL `https://arb-*.g.alchemy.com/v2/...` sólo
autentica JSON-RPC: no sustituye ninguno de los IDs, signing keys o el token de
Notify anteriores. Activa los flags no sensibles
`ALCHEMY_WEBHOOK_ENABLED=true` y `ALCHEMY_CUSTOM_WEBHOOK_ENABLED=true` sólo
después de crear ambos webhooks.

Un mismo `RPC_INDEXER_URLS` puede contener endpoints con rangos diferentes:
`RPC_PROVIDER_CAPABILITIES` declara `maxLogRange`, `maxConcurrency` y
`priority` para cada posición. El scanner elige sólo proveedores elegibles para
el span y `RPC_ADMISSION` aplica la concurrencia entre todas las instancias. No
hay reglas de plan por hostname. Ver `docs/runbooks/rpc-operations.md`.

**Política de claves (least privilege, `services/keys.ts` + `runtimeConfig.ts`):** en testnet, si falta una clave dedicada se cae a la más amplia (una sola EOA sirve para dev). En **mainnet los fallbacks están prohibidos** y las cuentas activas de relayer, faucet, paymaster, invoices y guardian deben ser distintas. El faucet usa su propio signer y lease de nonce; si está desactivado no exige una clave ociosa. `GET /health/live` sólo prueba liveness, `GET /health` expone estado y contadores sin detalles internos y `GET /health/ops` devuelve el diagnóstico completo únicamente con `X-Ops-Token`. Cualquier configuración mainnet incompleta bloquea requests con 503. Ver `DEPLOY.md` §11.

Los secretos de webhook nuevos usan `enc:v2:<key-id>` con AES-GCM y AAD. El job
de rotación recifra plaintext, `v1` y IDs anteriores mientras sus claves aparezcan en
`WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS`; elimina esa variable sólo cuando D1
ya no contenga filas antiguas.

Las integraciones opcionales (FCM; Turnstile solo en testnet) son feature-flagged: si su secret no está, el resto de la app funciona igual. Para dev local crea `server/.dev.vars` a partir de `server/.dev.vars.example`.

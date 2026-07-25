# Server (Cloudflare Worker)

API de Parmelia: Hono sobre Cloudflare Workers + D1. Ver `../ARCHITECTURE.md` para el detalle y `../DEPLOY.md` para el runbook de despliegue.

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
migraciones sobre un D1 aislado y prueba HTTP, CORS, Web Crypto, límites de body,
FK/STRICT, operaciones de cuenta durables y exclusión del lease de cron dentro
del runtime `workerd`.

Los logs de aplicación son JSON estructurado y pasan por `services/logger.ts`,
que limita mensajes y redacta credenciales, campos secretos y datos sensibles
de URLs. `pnpm check:server-console` bloquea usos directos de `console.*` fuera
de esa implementación.

Cada request recibe un `requestId` único y estable, expuesto en
`X-Request-Id` y reutilizado en logs y errores. Las integraciones HTTP externas
tienen timeout, lectura JSON acotada y liberan bodies ignorados. El cron renueva
su lease con ownership mientras corre y espera todos los jobs antes de liberarlo.

## Almacenamiento (D1)

Toda la data de la app vive en D1 (binding `PARMELIA_DB`): usuarios/usernames, wallet del usuario, `credential_id` (pista de UX), `referral_code`, estado del faucet, links de cobro, pagos pendientes (`prepare`↔`submit`), operaciones on-chain durables de cuenta/faucet/recovery, cotizaciones de swap, contactos y el **ledger** unificado de movimientos.

### Historial = ledger + indexer (sin indexador pago)

`/user/transactions` lee **solo** la tabla `ledger`:

- Lo que la app relaya (pagos, swaps, faucet) se escribe al confirmar - ambos lados en transferencias internas.
- Los **depósitos externos** entrantes los ingiere un **Cron Trigger** (`services/indexer.ts`, cada 2 min) escaneando logs `Transfer` ERC-20 con un cursor en `sync_state`. Escrituras idempotentes.

No depende de Blockscout/Etherscan/BlockVision en cada request.

### Migraciones

```txt
npx wrangler d1 migrations apply parmeliadb --local
npx wrangler d1 migrations apply parmeliadb --remote
```

`0001_schema.sql` es el esquema consolidado (con prólogo `DROP`, **solo aceptable sobre una DB de testnet** — nunca replicar ese patrón en migraciones para producción; las siguientes migraciones son aditivas o rebuilds copy-swap sin pérdida). Nuevas features = nueva migración numerada. **Orden de deploy:** listar y aplicar todas las migraciones hasta `0011_account_operations.sql` ANTES de desplegar el Worker que las usa.

**Ciclo de vida de un pago (`pending_payments.status`):** `prepared → submitting → submitted → confirmed | failed`. Cada transición es un compare-and-set atómico (un doble submit recibe 409 `PAYMENT_IN_PROGRESS`), el tx se registra inmediatamente después del broadcast y `/pay/submit` devuelve 202 sin mantener el request abierto. El éxito se decide por el **`UserOperationEvent` del EntryPoint** (no por `receipt.status`, que solo refleja el bundle: una ejecución interna revertida minaría igual). La contabilidad vive en `services/settlement.ts` (idempotente) y el **reconciliador** del cron resuelve filas varadas por una muerte del Worker: localiza la operación on-chain por su `userOpHash`, liquida o marca `failed`, repara el hand-off CCTP si fue interrumpido y expira lo que ya no puede aterrizar (ventana del paymaster vencida). `GET /pay/status/:userOpHash` expone el estado para polling.

**Ciclo de vida de cuenta/faucet/recovery (`account_operations.status`):**
`prepared → submitted → confirmed | failed | needs_review`. El Worker firma y
persiste la transacción cruda y su nonce **antes** del broadcast, protegido por
un lease D1 por firmante. Las rutas devuelven 202; el cliente consulta
`GET /account/operations/:id` y el cron reemite la misma transacción y reconcilia
el recibo. La finalización D1 es idempotente; un revert del faucet libera claim
y presupuesto, mientras `needs_review` bloquea otro envío del mismo tipo. El
mismo lease `chainId + signer` coordina `handleOps`, mints CCTP y operaciones de
cuenta; una reserva raw `prepared/needs_review` bloquea el firmante completo
hasta reconciliar, evitando reemplazos silenciosos de nonce. `/health` devuelve
503 con `signer_nonce_blocked` mientras exista una ambigüedad y
`d1_unavailable` si no puede comprobar D1.

## Secrets y variables

`vars` (en `wrangler.jsonc`) para config no sensible: `FIREBASE_PROJECT_ID`, `CHAIN_KEY`, `ALLOWED_ORIGINS`, `APP_URL`, las de fees (`PARMELIA_*`) y los flags cross-chain (`CROSSCHAIN_PAUSED`, `CROSSCHAIN_DISABLED_CHAINS`, `CROSSCHAIN_MIN_RELAYER_GAS_WEI`).

`wrangler secret put` (o `.dev.vars` local, gitignored) para lo sensible:

```txt
npx wrangler secret put RPC_URL                          # acepta varias URLs por coma (failover)
npx wrangler secret put PRIVATE_KEY                       # EOA operativa: relayer handleOps/CCTP
npx wrangler secret put FAUCET_PRIVATE_KEY                # EOA con presupuesto faucet (obligatoria si se activa en mainnet)
npx wrangler secret put RECOVERY_GUARDIAN_PRIVATE_KEY     # guardian dedicado (obligatorio y distinto en mainnet)
npx wrangler secret put PAYMASTER_SIGNER_PRIVATE_KEY      # firma sponsorships del paymaster
npx wrangler secret put PAYMENT_ROUTER_SIGNER_PRIVATE_KEY # firma autorizaciones de PaymentRouter (Flow B)
npx wrangler secret put TURNSTILE_SECRET_KEY              # anti-abuso (testnet: opcional; MAINNET: obligatorio, sin él create/fund fallan cerrado)
npx wrangler secret put FCM_SERVICE_ACCOUNT               # JSON del service account, 1 línea (opcional; sin definir = sin push)
npx wrangler secret put CCTP_RPC_URLS                     # opcional: JSON chainId->RPC para destinos cross-chain (si no, públicos)
npx wrangler secret put WEBHOOK_SECRET_ENCRYPTION_KEY     # 32 bytes base64/hex; AES-GCM para secretos HMAC (mainnet obligatorio)
npx wrangler secret put WEBHOOK_SECRET_ENCRYPTION_KEY_ID  # identificador corto de la clave activa
npx wrangler secret put WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS # JSON id->clave, sólo durante rotación
```

**Política de claves (least privilege, `services/keys.ts` + `runtimeConfig.ts`):** en testnet, si falta una clave dedicada se cae a la más amplia (una sola EOA sirve para dev). En **mainnet los fallbacks están prohibidos** y las cuentas activas de relayer, faucet, paymaster, invoices y guardian deben ser distintas. El faucet usa su propio signer y lease de nonce; si está desactivado no exige una clave ociosa. `GET /health` expone únicamente códigos de checks, nunca secretos; cualquier configuración mainnet incompleta bloquea requests y cron con 503. Ver `DEPLOY.md` §11.

Los secretos de webhook nuevos usan `enc:v2:<key-id>` con AES-GCM y AAD. El cron
recifra plaintext, `v1` y IDs anteriores mientras sus claves aparezcan en
`WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS`; elimina esa variable sólo cuando D1
ya no contenga filas antiguas.

Las integraciones opcionales (FCM; Turnstile solo en testnet) son feature-flagged: si su secret no está, el resto de la app funciona igual. Para dev local crea `server/.dev.vars` a partir de `server/.dev.vars.example`.

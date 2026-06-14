# Server (Cloudflare Worker)

API de Parmelia: Hono sobre Cloudflare Workers + D1. Ver `../ARCHITECTURE.md` para el detalle y `../DEPLOY.md` para el runbook de despliegue.

## Desarrollo local

```txt
pnpm install
pnpm --filter server dev      # o: npm run dev
pnpm --filter server test     # vitest (encoders de swap, fees, validación)
```

## Despliegue

```txt
npm run deploy
npm run cf-typegen            # regenerar tipos del Worker
```

## Almacenamiento (D1)

Toda la data de la app vive en D1 (binding `PARMELIA_DB`): usuarios/usernames, wallet del usuario, `credential_id` (pista de UX), `referral_code`, estado del faucet, links de cobro, operaciones pendientes (`prepare`↔`submit`), cotizaciones de swap, contactos y el **ledger** unificado de movimientos.

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

`0001_schema.sql` es el esquema consolidado (con prólogo `DROP`, seguro sobre una DB de testnet previa; incluye el token FCM de push notifications). Nuevas features = nueva migración numerada.

## Secrets y variables

`vars` (en `wrangler.jsonc`) para config no sensible: `FIREBASE_PROJECT_ID`, `CHAIN_KEY`, `ALLOWED_ORIGINS`, y las de fees (`PARMELIA_*`).

`wrangler secret put` (o `.dev.vars` local, gitignored) para lo sensible:

```txt
npx wrangler secret put RPC_URL                     # acepta varias URLs por coma (failover)
npx wrangler secret put PRIVATE_KEY                  # EOA relayer/deploy/guardian/faucet
npx wrangler secret put PAYMASTER_SIGNER_PRIVATE_KEY # firma del paymaster
npx wrangler secret put TURNSTILE_SECRET_KEY         # anti-abuso (opcional; sin definir = se omite)
npx wrangler secret put FCM_SERVICE_ACCOUNT          # JSON del service account, 1 línea (opcional; sin definir = sin push)
```

Las integraciones opcionales (Turnstile, FCM) son feature-flagged: si su secret no está, el resto de la app funciona igual. Para dev local crea `server/.dev.vars` a partir de `server/.dev.vars.example`.

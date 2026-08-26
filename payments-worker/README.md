# Payments Worker

`gatopago-payments-api` owns payment links, checkout intents, merchant API keys,
webhooks, quotes, execution attempts, settlement reconciliation and its own D1,
Queue and Durable Object. It does not own App accounts, passkeys, balances or
the App D1.

## Secrets

The canonical name-only inventory, provenance, acquisition and rotation guide
is [`docs/operations/worker-variables.md`](../docs/operations/worker-variables.md).
Never copy all App secrets into Payments.

The read-only snapshot from 2026-08-25 found these seven Cloudflare Secret
names:

- `PAYMENT_AUTHORIZATION_SIGNER_PRIVATE_KEY`
- `PAYMENT_RELAYER_PRIVATE_KEY`
- `PAYMENT_RPC_URLS`
- `WEBHOOK_SECRET_ENCRYPTION_KEY`
- `WEBHOOK_SECRET_ENCRYPTION_KEY_ID`
- `WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS`
- `OPS_HEALTH_TOKEN`

`CIRCLE_API_KEY` is supported but is not currently configured. Fee policy,
confirmations, live-mode gates, cutover checksum, contract addresses and
binding IDs are configuration rather than credentials.

For local development, copy `.dev.vars.example` to the ignored
`.dev.vars` and supply only the roles needed by the test. Sensitive example
assignments stay empty. For an approved remote rotation, load one value through
Wrangler's prompt:

```powershell
pnpm --filter payments-worker exec wrangler secret put NOMBRE --name gatopago-payments-api
```

This command creates a Worker version. Run the deployment preflight and prepare
rollback before using it. Do not pass values in arguments, logs, screenshots or
files inside the checkout.

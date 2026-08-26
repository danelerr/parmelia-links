# Security

## Reporting

Do not open a public issue containing credentials, private keys, passkey
material, exploit details, or user data. Contact the repository owner through a
private channel and include the affected component, impact, reproduction steps,
and whether funds or credentials may already be exposed.

## Secret handling

- El inventario canónico, la procedencia comprobable, los pasos de obtención y
  la matriz de rotación están en
  [`docs/operations/worker-variables.md`](./docs/operations/worker-variables.md).
- Production secrets are stored with `wrangler secret put`; they do not belong
  in source, `wrangler.jsonc`, screenshots, ZIP archives, or shared logs.
- Local development uses `server/.dev.vars` and `payments-worker/.dev.vars`,
  both ignored. Only empty/example values belong in their `.dev.vars.example`.
- `VITE_*` is public build-time configuration and must never contain a private
  key, service-account JSON, provider token or server-side secret.
- As of 2026-08-25, real values still exist in ignored files under this
  OneDrive checkout (`server/.dev.vars`, `contracts/.env` and Vercel local
  caches). They are not tracked by Git, but `.gitignore` is not isolation. Their
  removal/rotation remains the P0 external action recorded in `docs/roadmap.md`.
- Firebase service-account JSON files must never remain in the repository
  workspace. `FCM_SERVICE_ACCOUNT` contains the minified JSON at runtime.
- Signing roles use distinct keys in mainnet. App owns the UserOp relayer,
  paymaster signer, recovery guardian and faucet; Payments owns the EIP-712
  authorization signer and CCTP mint relayer. A key is never shared just because
  both deployables run under the same Cloudflare account.
- Webhook encryption keys follow the rotation procedure in `DEPLOY.md`; previous
  keys are removed only after every row has been re-encrypted.
- The testnet Phase 2.1 helper reused `wallet-0x75` for the Payments
  authorization signer and relayer and unlocked it with an empty password.
  `PAYMENT_LIVE_ENABLED=false` contains that choice to testnet; both roles and
  the keystore protection must be replaced before mainnet.

Before a manual production release, scan both Git history and the checked-out
tree with Gitleaks. Semgrep and Slither provide additional local blocking
static-analysis gates.

Worker releases are manual. The operator runs `pnpm verify:all`, creates and
restore-checks independent App/Payments backups, applies pending migrations,
deploys Payments before App and requires both `/health` gates. If a Worker is unhealthy, the
operator explicitly rolls back to the previous stable Worker version and checks
readiness again. D1 recovery remains a separate, explicit action and must never
be inferred from a Worker rollback.

`/health/live` is public liveness only on both Workers. `/health` exposes readiness status and
aggregate counts without internal provider, queue, or error details. The full
`/health/ops` payload requires a dedicated 32+ character `OPS_HEALTH_TOKEN` in
the `X-Ops-Token` header and deliberately returns 404 when authentication fails.

## Backend trust boundary

- `GATOPAGO_DB` is never bound to Payments and `PAYMENTS_DB` is never bound to
  App. Architecture checks fail CI on cross-domain imports/bindings.
- App → Payments uses a Cloudflare Service Binding plus versioned commands and
  explicit service/user/request claims. The claim is context, not a bearer
  credential exposed on HTTP; Payments has no reverse binding.
- Dashboard Firebase tokens are verified independently by Payments. API keys
  and encrypted webhook secrets exist only in `PAYMENTS_DB`.
- Queue delivery is at-least-once. Stable dedupe keys, leases, one-active-attempt
  constraints and transactional event/outbox writes provide logical-once
  effects; documentation never promises exactly-once transport.
- A settlement Worker is not pre-provisioned. Extraction requires measured
  resource or isolation pressure, preventing unnecessary new secret and network
  surfaces.

## Economic and sponsorship boundaries

- GatoPago platform fees are opt-in. Missing `PAYMENT_FEE_POLICY_JSON` resolves
  to the immutable `free-default` policy; application product fees also require
  the explicit master switch `GATOPAGO_FEES_ENABLED=true`.
- A positive checkout fee cannot be signed unless the route's declared cap,
  deployed cap, authorization signer and treasury all match. Policy errors,
  equal-priority ambiguity and RPC uncertainty fail closed.
- Every quote and attempt keeps an immutable policy/cap snapshot. The fee ledger
  stores platform and network fees separately, including quoted/actual amounts
  and transaction evidence. Circle fees are never labeled as GatoPago revenue.
- Sponsorship fallback runs only while the UserOperation is unsigned. Because
  ERC-4337 signs `paymasterAndData`, changing provider or paymaster after prepare
  requires a new UserOperation and a new passkey signature.
- `pending_payments` records the provider and exact paymaster address. During a
  rotation the old paymaster remains funded and operational until no active row
  references it and the maximum sponsorship window has elapsed.
- An ERC-7677 provider must use bounded HTTPS responses; mainnet also pins the
  expected returned paymaster contract. A self-funded fallback is explicit and
  checks native balance plus EntryPoint deposit before asking the user to sign.

## Credential incident response

If a secret is found in a workspace or artifact:

1. Revoke or disable it at the provider immediately. Deleting the local file is
   not revocation.
2. Review provider audit logs and on-chain activity from the first possible
   exposure time.
3. Create a least-privilege replacement and store it with `wrangler secret put`.
4. Deploy, verify the dependent feature, then remove the old secret everywhere.
5. Run `gitleaks git --redact --verbose .` and `gitleaks dir --config
   .gitleaks-worktree.toml --redact --verbose .`; rotate again if either scan
   finds the replacement.

On 2026-07-14, a gitignored Firebase service-account JSON was removed from the
local workspace. Its provider-side revocation remains an operator action that
must be confirmed in GCP/Firebase before relying on deletion as containment.

On 2026-08-25, a local inventory command printed an ignored Vercel development
OIDC token and the ignored Etherscan API key into the diagnostic session output.
No onchain private key, service-account JSON or Cloudflare Secret was printed.
Treat the two displayed credentials as exposed: let the short-lived OIDC token
expire and remove its local cache; revoke/replace the Etherscan key and inspect
its usage log. The canonical inventory records the exact files and safe
replacement procedure without recording either value.

## Temporary audit exception

`GHSA-qwww-vcr4-c8h2` is ignored narrowly in `pnpm-workspace.yaml` as of
2026-07-25. The advisory affects only React Router's unstable RSC code paths;
GatoPago is a client-side Vite application and does not use them. The announced
fixed release (`8.3.0`) was not available in npm when this exception was added,
while downgrading below `7.18.0` reintroduced multiple older advisories.

`pnpm check:router-rsc` fails local release verification if an affected unstable
RSC API appears. Remove the exception and this note immediately after a
compatible fixed release is published and its build/e2e gates pass. This
exception does not cover any other GHSA or CVE.

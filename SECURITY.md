# Security

## Reporting

Do not open a public issue containing credentials, private keys, passkey
material, exploit details, or user data. Contact the repository owner through a
private channel and include the affected component, impact, reproduction steps,
and whether funds or credentials may already be exposed.

## Secret handling

- Production secrets are stored with `wrangler secret put`; they do not belong
  in source, `wrangler.jsonc`, screenshots, ZIP archives, or shared logs.
- Local development uses `server/.dev.vars`, which is ignored. Only empty names
  and documentation belong in `server/.dev.vars.example`.
- Firebase service-account JSON files must never remain in the repository
  workspace. `FCM_SERVICE_ACCOUNT` contains the minified JSON at runtime.
- Signing roles use distinct keys in mainnet: relayer, paymaster signer,
  PaymentRouter signer, recovery guardian, and faucet whenever it is enabled.
- Webhook encryption keys follow the rotation procedure in `DEPLOY.md`; previous
  keys are removed only after every row has been re-encrypted.

Before a manual production release, scan both Git history and the checked-out
tree with Gitleaks. Semgrep and Slither provide additional local blocking
static-analysis gates.

Worker releases are manual. The operator runs `pnpm verify:all`, creates and
restore-checks an encrypted D1 backup, applies pending migrations, deploys with
Wrangler and requires `/health` readiness. If the new Worker is unhealthy, the
operator explicitly rolls back to the previous stable Worker version and checks
readiness again. D1 recovery remains a separate, explicit action and must never
be inferred from a Worker rollback.

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

## Temporary audit exception

`GHSA-qwww-vcr4-c8h2` is ignored narrowly in `pnpm-workspace.yaml` as of
2026-07-25. The advisory affects only React Router's unstable RSC code paths;
Parmelia is a client-side Vite application and does not use them. The announced
fixed release (`8.3.0`) was not available in npm when this exception was added,
while downgrading below `7.18.0` reintroduced multiple older advisories.

`pnpm check:router-rsc` fails local release verification if an affected unstable
RSC API appears. Remove the exception and this note immediately after a
compatible fixed release is published and its build/e2e gates pass. This
exception does not cover any other GHSA or CVE.

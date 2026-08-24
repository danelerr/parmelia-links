# GatoPago

**Tus dólares ya saben moverse.**

Programmable onchain account for stablecoin payments, guided DeFi, and developer APIs on Arbitrum.

GatoPago lets anyone receive, request, and swap USDC through payment links, QR
codes, usernames, and a mobile PWA — secured by **WebAuthn passkeys** and
**ERC-4337 smart accounts**. No seed phrases. No gas for the user.

- **Live app:** https://app.parmelia.me
- **Landing:** https://parmelia.me
- **Landing repo:** https://github.com/danelerr/parmelia-landing
- **Product, strategy, and brand documentation:** https://github.com/danelerr/parmelia-landing/tree/main/documentacion
- **Technical documentation:** [docs/README.md](docs/README.md)
- **Chain:** Arbitrum Sepolia (configuration ready for Arbitrum One)

> GatoPago existed before the Arbitrum Open House London Buildathon as a portable
> payment-link prototype. During the event it became an Arbitrum-native payments
> product with its V2 smart-account stack deployed and verified on Arbitrum
> Sepolia, sponsored gas, swaps, rebranding, and a PWA.

---

## The problem

Stablecoins are already how many people in Latin America and other dollarized
markets save and get paid. But the payment experience is still built for crypto
natives: wallet addresses, seed phrases, gas, networks, transaction hashes, and
signing flows. That friction is the adoption barrier.

GatoPago turns that into a familiar payment flow — create a profile, share a
link, scan a QR, pay a username, confirm with your fingerprint — without taking
custody of user funds.

## What you can do today

- Create a wallet with a **passkey** (biometrics), no seed phrase.
- Receive payments through **public links and QR codes**.
- Send to **usernames**, scanned QR codes, or addresses.
- A **ledger-based activity feed** with payments, deposits, swaps, receipts
  (date, time, and a receipt number = tx hash), and a **statement page** with
  shareable URL filters.
- An **integrated swap module** with Uniswap routing and server-side quoting.
- **Cross-chain USDC** via Circle CCTP v2: send to another chain from the app,
  and a public checkout (`/cc/username`) so external wallets can pay in from
  other chains (code complete; pending deploy + Flow A smoke test).
- A **merchant dashboard** (API keys, payment intents, webhooks with signed
  deliveries and retries, sandbox) backed by a `/v1` payments API in test mode.
- **Contacts, invites, push notifications**, ES/EN i18n, and an installable **PWA**.

## What is onchain (Account Abstraction)

- **ERC-4337 smart accounts** on the canonical EntryPoint v0.9.
- **WebAuthn / passkey** authorization via an ERC-7913 P256 verifier (RIP-7212).
- **Deterministic CREATE2 deployment** — same addresses across chains.
- **ParmeliaPaymaster**: sponsored UserOperations with signed `[validAfter,
  validUntil]` windows so a signed-but-unsubmitted op cannot be replayed.
- Smart account built for **multiple passkeys (ERC-7913), batching (ERC-7821),
  UUPS upgradeability, and guardian recovery** with a 48h timelock.

The backend relays UserOperations and sponsors gas, but **cannot move user funds**
— every payment requires the user's passkey signature.

## Deployed contracts — Arbitrum Sepolia (421614)

| Contract | Address |
|---|---|
| EntryPoint v0.9 (canonical) | [`0x433709009B8330FDa32311DF1C2AFA402eD8D009`](https://sepolia.arbiscan.io/address/0x433709009B8330FDa32311DF1C2AFA402eD8D009) |
| ERC7913WebAuthnVerifier | [`0xb7fA10dEe75042D6973676A7d7882e4621B806d6`](https://sepolia.arbiscan.io/address/0xb7fA10dEe75042D6973676A7d7882e4621B806d6) |
| AccountWebAuthnV2 (impl) | [`0xa450bc49a0dA738FA348445980b542d78A22527e`](https://sepolia.arbiscan.io/address/0xa450bc49a0dA738FA348445980b542d78A22527e) |
| AccountFactoryV2 | [`0x75c7761dcED5F8eCc708E750bDe5CA7d4557EDEB`](https://sepolia.arbiscan.io/address/0x75c7761dcED5F8eCc708E750bDe5CA7d4557EDEB) |
| ParmeliaPaymaster | [`0x31f357a64cF5899da21337f0D9e28ef8D6385753`](https://sepolia.arbiscan.io/address/0x31f357a64cF5899da21337f0D9e28ef8D6385753) |
| ParmeliaPaymentRouter (Flow B) | [`0x607fF0c2eE5E4ae9a7bD2F7E343ea53a1992975A`](https://sepolia.arbiscan.io/address/0x607fF0c2eE5E4ae9a7bD2F7E343ea53a1992975A) |
| ParmeliaCrosschainRouter (CCTP) | [`0x0816d13337C3A7a03Df639F40993e88B771dD777`](https://sepolia.arbiscan.io/address/0x0816d13337C3A7a03Df639F40993e88B771dD777) |

Contract sources have moved ahead of these deployments in some places (e.g.
`payInvoiceWithPermit`, recovery-proposal validation, the paymaster gas-cost
cap): those improvements take effect on the next redeploy and are feature-flagged
off until then. See [contracts/AUDIT.md](contracts/AUDIT.md).

## Why Arbitrum

Consumer payments need the chain to disappear. Arbitrum gives GatoPago true
pay-for-what-you-use gas (no reserved-gas overcharge), low and predictable fees,
EIP-712 support, a **canonical and verified ERC-4337 EntryPoint**, mature EVM
tooling, and deep DeFi liquidity for swaps. It is the practical foundation to
make stablecoin payments feel fast, affordable, and reliable.

## Tech stack

React 19 · TypeScript · Vite · Tailwind v4 (client) · Hono on Cloudflare Workers
+ D1 + Queues + Durable Objects (backend) · viem · Solidity + Foundry + OpenZeppelin v5 (contracts) ·
Firebase Auth/Messaging · Arbitrum.

## Architecture

Full write-up in [ARCHITECTURE.md](ARCHITECTURE.md). Provider-neutral RPC
capabilities, partitioned indexing and the WebSocket decision are covered in
[docs/runbooks/rpc-operations.md](docs/runbooks/rpc-operations.md). In short:

```
client / Alchemy webhooks ──> Worker + D1 ──> event scheduler ──> Queue ──> Arbitrum
  passkeys, fast signal        source of truth    alarms only      bounded    ERC-4337
  domain state + safety sweep  idempotent rows    with work        jobs       contracts
```

There is no static Cron Trigger. Active wallets retain one configurable safety
alarm so missed provider webhooks are reconciled even when nobody opens the app;
it schedules only lagging shards and stops completely when there are no active
wallets. Equivalent events are coalesced per partition before they reach Queue,
and independent shards can scale horizontally.

The zero-RPC Home invariant and bounded 1/100/1,000-identity load procedure are
documented in
[docs/runbooks/home-capacity.md](docs/runbooks/home-capacity.md).

## Run locally

See [DEPLOY.md](DEPLOY.md) for the full runbook. Quick start:

```bash
pnpm install
pnpm --filter client dev      # web app
cd server && npx wrangler dev  # API (needs .dev.vars)
cd contracts && forge test     # contracts
pnpm verify                    # lint + types + server tests + builds + bundle budgets
pnpm check:contracts:storage   # append-only storage-layout gate
pnpm check:contracts:coverage  # Foundry coverage floors for critical contracts
pnpm check:d1:restore          # encrypted export + isolated D1 restore drill
pnpm check:release-artifact    # release manifest tamper/extra-file drill
pnpm check:openapi             # strict OpenAPI 3.1 structure/reference lint
pnpm test:e2e                  # Chrome: client/dashboard desktop + mobile
```

## Tests

- Contracts: `cd contracts && forge test` — 124 unit tests passing (Foundry: account +
  recovery hardening, paymaster + gas-cost cap, payment router incl. permit,
  crosschain router, upgrade-path storage regression).
- `pnpm verify:all` enforces append-only contract storage layouts and
  per-contract coverage floors. Current branch coverage is 88.24% for
  `AccountWebAuthnV2` and 100% for Factory, Paymaster, PaymentRouter and
  CrosschainRouter.
- Arbitrum One deployment scripts reject missing/reused owner, treasury,
  broadcaster and signing roles before broadcast; testnet retains simple defaults.
- Server: `pnpm --filter server test` — Node tests plus tests inside
  `workerd` with a real isolated D1 binding. Coverage includes OpenAPI drift,
  key rotation, production readiness, all eleven migrations, schema constraints,
  authentication, body limits, Web Crypto, event coalescing and lease ownership, in addition to swap encoding,
  fee/slippage math, validation, UserOperation serialization, error contract,
  CCTP message validation, key policy, durable account operations and faucet/turnstile fail-closed).
- Redocly validates the public API with the OpenAPI 3.1 `recommended-strict`
  ruleset, while the server test suite independently requires an exact match
  between every documented `/v1` method/path and the routes registered by Hono.
- Server logs are structured and centrally redact credentials, secret fields and
  sensitive URL data. `pnpm check:server-console` prevents direct `console.*`
  calls outside the logger implementation.
- `pnpm check:d1:restore` applies all D1 migrations to a local fixture, encrypts
  its export with AES-256-GCM, restores it into a second isolated D1 and requires
  integrity/FK checks plus the fixture join to survive.
- Production operations are manual: the operator runs `pnpm verify:all`, creates
  and restore-checks an encrypted D1 backup, applies pending migrations, deploys
  with Wrangler and requires a healthy `/health` response. Rollback is also an
  explicit Wrangler operation; D1 is never rolled back automatically.
- Lint is blocking (`--max-warnings 0`) on `client`, `dashboard` and `server`;
  server lint is type-aware and rejects floating or misused promises.
- `pnpm test:fork` runs three live integration tests for deployed GatoPago,
  EntryPoint, CCTP, Uniswap and Aave contracts, including Aave supply/withdraw
  and CCTP burn state changes.
- Manual release verification scans Git history and the checked-out worktree
  with Gitleaks and executes twelve Playwright checks across four viewport
  profiles, including automated WCAG 2.2 AA rules and keyboard focus order.
  Semgrep, a reviewed Slither medium/high gate and Foundry lint remain available
  as local blocking checks.

## Security model

Non-custodial by design. Identity (Firebase) is separate from custody (the
passkey-controlled smart account). The server's keys can deploy accounts, pay
gas, and relay `handleOps`, but **cannot move funds** without a valid passkey
signature the contract accepts. Key-separation guidance for mainnet is in
[DEPLOY.md](DEPLOY.md) §11.
Private reporting, secret handling and incident response are documented in
[SECURITY.md](SECURITY.md).

## Roadmap

Shipped since the buildathon: the **Stripe-like payments API** (test mode, with
merchant dashboard and signed webhooks) and **cross-chain USDC via CCTP v2**
(code complete, pending deploy). Designed as the next phases: a **GatoPago
card** and **local bank-QR settlement** so people can spend their stablecoin
balance in the real world, and **Earn** on idle balances. The DeFi direction is
written up in [the DeFi design](docs/design/defi.md), the API direction in
[the API design](docs/design/api.md), and cross-chain in
[the cross-chain design](docs/design/cross-chain.md). The dated evidence is in
[the current technical audit](docs/audits/2026-08-23.md), while actionable work
lives only in the [technical roadmap](docs/roadmap.md).

## Repository layout

```
client/      React PWA (deployed to Vercel → app.parmelia.me)
server/      Cloudflare Worker API (Hono + D1 + event-driven indexer/relayer)
dashboard/   Merchant dashboard (React; API keys, payments, webhooks, sandbox)
contracts/   Foundry: AccountWebAuthnV2, AccountFactoryV2, ParmeliaPaymaster,
             ParmeliaPaymentRouter, ParmeliaCrosschainRouter, verifier
shared/      Network config, ABIs, error contract (source of truth)
docs/        Technical index, designs, API reference, operations, audits and runbooks
```

Landing page lives in a separate repo:
[danelerr/parmelia-landing](https://github.com/danelerr/parmelia-landing).

# Parmelia

**Non-custodial stablecoin payments on Arbitrum — as simple as sending a message.**

Parmelia lets anyone receive, request, and swap USDC through payment links, QR
codes, usernames, and a mobile PWA — secured by **WebAuthn passkeys** and
**ERC-4337 smart accounts**. No seed phrases. No gas for the user.

- **Live app:** https://app.parmelia.me
- **Landing:** https://parmelia.me
- **Landing repo:** https://github.com/danelerr/parmelia-landing
- **Chain:** Arbitrum Sepolia (configuration ready for Arbitrum One)

> Submitted to the **Arbitrum Open House London Buildathon**. Parmelia existed
> before the event as a portable payment-link prototype; during the buildathon it
> became an Arbitrum-native payments product (V2 smart-account stack deployed and
> verified on Arbitrum Sepolia, sponsored gas, swaps, full rebrand, PWA). See
> [BUILDATHON_FORM.md](BUILDATHON_FORM.md) for the submission details.

---

## The problem

Stablecoins are already how many people in Latin America and other dollarized
markets save and get paid. But the payment experience is still built for crypto
natives: wallet addresses, seed phrases, gas, networks, transaction hashes, and
signing flows. That friction is the adoption barrier.

Parmelia turns that into a familiar payment flow — create a profile, share a
link, scan a QR, pay a username, confirm with your fingerprint — without taking
custody of user funds.

## What you can do today

- Create a wallet with a **passkey** (biometrics), no seed phrase.
- Receive payments through **public links and QR codes**.
- Send to **usernames**, scanned QR codes, or addresses.
- A **ledger-based activity feed** with payments, deposits, swaps, and receipts
  (date, time, and a receipt number = tx hash).
- An **integrated swap module** with Uniswap routing and server-side quoting.
- **Contacts, invites, push notifications**, and an installable **PWA**.

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

## Why Arbitrum

Consumer payments need the chain to disappear. Arbitrum gives Parmelia true
pay-for-what-you-use gas (no reserved-gas overcharge), low and predictable fees,
EIP-712 support, a **canonical and verified ERC-4337 EntryPoint**, mature EVM
tooling, and deep DeFi liquidity for swaps. It is the practical foundation to
make stablecoin payments feel fast, affordable, and reliable.

## Tech stack

React 19 · TypeScript · Vite · Tailwind v4 (client) · Hono on Cloudflare Workers
+ D1 (backend) · viem · Solidity + Foundry + OpenZeppelin v5 (contracts) ·
Firebase Auth/Messaging · Arbitrum.

## Architecture

Full write-up in [ARCHITECTURE.md](ARCHITECTURE.md). In short:

```
client (React PWA)  ──>  Cloudflare Worker (Hono + D1)  ──>  Arbitrum
  passkeys/WebAuthn        builds & relays UserOps             ERC-4337
  payment links/QR         paymaster sponsors gas              smart accounts
  swaps, receipts          ledger + cron indexer               Uniswap
```

## Run locally

See [DEPLOY.md](DEPLOY.md) for the full runbook. Quick start:

```bash
pnpm install
pnpm --filter client dev      # web app
cd server && npx wrangler dev  # API (needs .dev.vars)
cd contracts && forge test     # contracts
```

## Tests

- Contracts: `cd contracts && forge test` — 32 passing (Foundry).
- Server: `pnpm --filter server test` — 34 passing (Vitest: swap encoding,
  fee/slippage math, validation, UserOperation serialization).

## Security model

Non-custodial by design. Identity (Firebase) is separate from custody (the
passkey-controlled smart account). The server's keys can deploy accounts, pay
gas, and relay `handleOps`, but **cannot move funds** without a valid passkey
signature the contract accepts. Key-separation guidance for mainnet is in
[DEPLOY.md](DEPLOY.md) §11.

## Roadmap

Designed as the next phases, not presented as live features: a **Parmelia card**
and **local bank-QR settlement** so people can spend their stablecoin balance in
the real world, **Earn** on idle balances, **cross-chain deposits**, and a
**Stripe-like payments API** for stablecoins. The DeFi direction is written up in
[DEFI_DESIGN.md](DEFI_DESIGN.md) and the API direction in
[API_DESIGN.md](API_DESIGN.md).

## Repository layout

```
client/      React PWA (deployed to Vercel → app.parmelia.me)
server/      Cloudflare Worker API (Hono + D1)
contracts/   Foundry: AccountWebAuthnV2, AccountFactoryV2, ParmeliaPaymaster, verifier
shared/      Network config, ABIs, token + Uniswap addresses (source of truth)
```

Landing page lives in a separate repo:
[danelerr/parmelia-landing](https://github.com/danelerr/parmelia-landing).

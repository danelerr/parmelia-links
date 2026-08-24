# GatoPago Contracts

ERC-4337 smart-account stack for GatoPago, built with Foundry + OpenZeppelin v5.
See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for the system overview and
[`../DEPLOY.md`](../DEPLOY.md) for the deployment runbook.

## Contracts

| Contract | Purpose |
|---|---|
| `AccountWebAuthnV2.sol` | User smart account: MultiSigner (ERC-7913) + batched execution (ERC-7821) + UUPS upgradeable + guardian recovery with a 48h timelock. Multiple passkeys per account, all on the same address. |
| `AccountFactoryV2.sol` | Deploys account proxies. `predictAddress(initData)` gives the deterministic (CREATE2) address; `createAccount(initData)` deploys it. |
| `ParmeliaPaymaster.sol` | Verifying paymaster. Sponsors gas for UserOperations signed by a trusted backend signer, bound to a `[validAfter, validUntil]` window so a signed-but-unsubmitted op cannot be replayed. `Ownable2Step`; `postOp` is the hook for future fees. |
| `ERC7913WebAuthnVerifier.sol` | Stateless WebAuthn/P256 signature verifier referenced by the account's signers (uses RIP-7212 where available). |
| `ParmeliaPaymentRouterV2.sol` | USDC-only same-chain checkout. EIP-712 binds payer, intent, attempt, merchant, net settlement, fee and expiry. |
| `ParmeliaCctpPaymentRouter.sol` | Base/Avalanche USDC checkout into the Arbitrum home chain through CCTP v2. Destination and recovery semantics are immutable. |
| `ParmeliaCrosschainRouter.sol` | Hardened outbound CCTP rail for GatoPago accounts, with replay and destination-domain guards. |

## Design notes (relevant to "smart contract quality")

- **Deterministic addresses (CREATE2):** a fixed salt through the canonical
  CREATE2 deployer yields identical contract addresses on every chain, so each
  user keeps the same wallet address across chains. Migration is trivial.
- **Non-custodial:** the backend cannot move funds — execution requires a valid
  WebAuthn signature the account verifies on-chain. P256 signatures are
  normalized to low-s (OpenZeppelin).
- **Replay-safe sponsorship:** the paymaster signs over the op fields *and* the
  validity window; the EntryPoint enforces it.
- **Explicit ownership:** the paymaster takes its owner as a constructor argument
  (CREATE2 deploys via a factory, so `msg.sender` is not the deployer). Deploy
  with `--sender <your EOA>`. See [`../DEPLOY.md`](../DEPLOY.md) §2.
- **Size:** the optimizer is on with high `runs`; the account stays under the
  24,576-byte EIP-170 limit (~15 KB) while optimizing runtime gas (the impl is
  delegatecalled on every UserOp).

## Deployed + verified — Arbitrum Sepolia (421614)

| Contract | Address |
|---|---|
| ERC7913WebAuthnVerifier | [`0x14D5D46fc6ED1154F3719f87ae72C3020d4fb886`](https://sepolia.arbiscan.io/address/0x14D5D46fc6ED1154F3719f87ae72C3020d4fb886) |
| AccountWebAuthnV2 (impl) | [`0xDFA9df7d6CCc3b92F8a8e245D6E9760c3346184C`](https://sepolia.arbiscan.io/address/0xDFA9df7d6CCc3b92F8a8e245D6E9760c3346184C) |
| AccountFactoryV2 | [`0xb97E923E27CB258012081446e4b436afd3974108`](https://sepolia.arbiscan.io/address/0xb97E923E27CB258012081446e4b436afd3974108) |
| ParmeliaPaymaster | [`0x913a1B51c4f5b1a458A56D0d700c956834cc1d15`](https://sepolia.arbiscan.io/address/0x913a1B51c4f5b1a458A56D0d700c956834cc1d15) |
| ParmeliaPaymentRouterV2 | [`0x64e0B48A4D360B235C3fEDe2431D79413aebb7A4`](https://sourcify.dev/server/v2/contract/421614/0x64e0B48A4D360B235C3fEDe2431D79413aebb7A4) |
| ParmeliaCrosschainRouter | [`0xD089c3764a8F2E62eFDf280Eb2432c1dC647400c`](https://sourcify.dev/server/v2/contract/421614/0xD089c3764a8F2E62eFDf280Eb2432c1dC647400c) |
| EntryPoint v0.9 (canonical) | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` |

## Build, test, deploy

Use Foundry `v1.7.1`, the same stable release pinned in CI.

```bash
foundryup -i v1.7.1
forge build
forge test

# Deterministic deploy (see ../DEPLOY.md for the full flow). --sender is required.
forge script script/Deploy.s.sol:DeployV2 \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
  --account <keystore> --sender <your-eoa> --broadcast
```

Compiler and optimizer settings in `foundry.toml` are fixed (Solidity 0.8.34,
`via_ir`, `optimizer_runs`) so
CREATE2 yields the same addresses across Arbitrum Sepolia and Arbitrum One — do
not change them between deployments.

Universal Checkout deployment facts are frozen in
`script/NetworkDeploymentConfig.sol`; generated manifests and their schema live
in `deployments/`. A dry-run does not qualify as a deployment manifest.

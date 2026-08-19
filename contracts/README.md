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
| ERC7913WebAuthnVerifier | [`0xb7fA10dEe75042D6973676A7d7882e4621B806d6`](https://sepolia.arbiscan.io/address/0xb7fA10dEe75042D6973676A7d7882e4621B806d6) |
| AccountWebAuthnV2 (impl) | [`0xa450bc49a0dA738FA348445980b542d78A22527e`](https://sepolia.arbiscan.io/address/0xa450bc49a0dA738FA348445980b542d78A22527e) |
| AccountFactoryV2 | [`0x75c7761dcED5F8eCc708E750bDe5CA7d4557EDEB`](https://sepolia.arbiscan.io/address/0x75c7761dcED5F8eCc708E750bDe5CA7d4557EDEB) |
| ParmeliaPaymaster | [`0x31f357a64cF5899da21337f0D9e28ef8D6385753`](https://sepolia.arbiscan.io/address/0x31f357a64cF5899da21337f0D9e28ef8D6385753) |
| EntryPoint v0.9 (canonical) | `0x433709009B8330FDa32311DF1C2AFA402eD8D009` |

## Build, test, deploy

```bash
forge build
forge test           # 32 tests (account, factory, paymaster, verifier)

# Deterministic deploy (see ../DEPLOY.md for the full flow). --sender is required.
forge script script/Deploy.s.sol:DeployV2 \
  --rpc-url https://sepolia-rollup.arbitrum.io/rpc \
  --account <keystore> --sender <your-eoa> --broadcast
```

Optimizer settings in `foundry.toml` are fixed (`via_ir`, `optimizer_runs`) so
CREATE2 yields the same addresses across Arbitrum Sepolia and Arbitrum One — do
not change them between deployments.

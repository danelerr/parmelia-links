// Signing-key policy (least privilege).
//
// The backend holds distinct signing roles with different blast radii:
//   - PRIVATE_KEY                        relayer EOA: handleOps and CCTP
//   - FAUCET_PRIVATE_KEY                 transfers the configured welcome funds
//   - PAYMASTER_SIGNER_PRIVATE_KEY       signs gas sponsorships (paymasterAndData)
//   - PAYMENT_ROUTER_SIGNER_PRIVATE_KEY  signs PaymentRouter invoice authorizations
//   - RECOVERY_GUARDIAN_PRIVATE_KEY      proposes/cancels recovery
//
// On TESTNETS a missing dedicated key may fall back to a broader one so a
// single-EOA dev/testnet setup keeps working (documented in DEPLOY.md §11).
// On MAINNET the fallback is forbidden: a missing dedicated key is a hard
// configuration error, so one leaked key can never sign every surface.

import { getNetworkConfig } from "../../../shared";
import { privateKeyToAccount } from "viem/accounts";
import type { Bindings } from "../middlewares/auth";
import { logWarn } from "./logger";

export class KeyConfigError extends Error {
	constructor(role: string) {
		super(
			`Missing dedicated signing key for '${role}' on a mainnet network. ` +
				`Set the dedicated secret (see DEPLOY.md §11); key fallbacks are testnet-only.`,
		);
		this.name = "KeyConfigError";
	}
}

function isTestnet(env: Bindings): boolean {
	return getNetworkConfig(env.CHAIN_KEY).isTestnet;
}

/** Faucet funding key. Testnet may reuse PRIVATE_KEY; mainnet never may. */
export function getFaucetKey(env: Bindings): `0x${string}` {
	const dedicated = env.FAUCET_PRIVATE_KEY as `0x${string}` | undefined;
	if (dedicated) {
		if (
			!isTestnet(env) &&
			privateKeyToAccount(dedicated).address.toLowerCase() ===
				privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`).address.toLowerCase()
		) {
			throw new KeyConfigError("FAUCET_PRIVATE_KEY (must differ from PRIVATE_KEY)");
		}
		return dedicated;
	}
	if (!isTestnet(env)) throw new KeyConfigError("FAUCET_PRIVATE_KEY");
	logWarn("key_fallback_faucet", { fallback: "PRIVATE_KEY", testnetOnly: true });
	return env.PRIVATE_KEY as `0x${string}`;
}

/** Key that signs paymaster sponsorships. Testnet-only fallback to PRIVATE_KEY. */
export function getPaymasterSignerKey(env: Bindings): `0x${string}` {
	if (env.PAYMASTER_SIGNER_PRIVATE_KEY) return env.PAYMASTER_SIGNER_PRIVATE_KEY as `0x${string}`;
	if (!isTestnet(env)) throw new KeyConfigError("PAYMASTER_SIGNER_PRIVATE_KEY");
	logWarn("key_fallback_paymaster_signer", { fallback: "PRIVATE_KEY", testnetOnly: true });
	return env.PRIVATE_KEY as `0x${string}`;
}

/** Key that signs PaymentRouter invoice authorizations. Testnet-only fallback. */
export function getRouterSignerKey(env: Bindings): `0x${string}` | null {
	if (env.PAYMENT_ROUTER_SIGNER_PRIVATE_KEY) {
		return env.PAYMENT_ROUTER_SIGNER_PRIVATE_KEY as `0x${string}`;
	}
	if (!isTestnet(env)) throw new KeyConfigError("PAYMENT_ROUTER_SIGNER_PRIVATE_KEY");
	const fallback = env.PAYMASTER_SIGNER_PRIVATE_KEY ?? null;
	if (fallback) logWarn("key_fallback_router_signer", { fallback: "PAYMASTER_SIGNER_PRIVATE_KEY", testnetOnly: true });
	return fallback as `0x${string}` | null;
}

/** Guardian key for recovery proposals/cancellation. Never shared on mainnet. */
export function getRecoveryGuardianKey(env: Bindings): `0x${string}` {
	const dedicated = env.RECOVERY_GUARDIAN_PRIVATE_KEY as `0x${string}` | undefined;
	if (dedicated) {
		if (
			!isTestnet(env) &&
			privateKeyToAccount(dedicated).address.toLowerCase() ===
				privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`).address.toLowerCase()
		) {
			throw new KeyConfigError("RECOVERY_GUARDIAN_PRIVATE_KEY (must differ from PRIVATE_KEY)");
		}
		return dedicated;
	}
	if (!isTestnet(env)) throw new KeyConfigError("RECOVERY_GUARDIAN_PRIVATE_KEY");
	logWarn("key_fallback_recovery_guardian", { fallback: "PRIVATE_KEY", testnetOnly: true });
	return env.PRIVATE_KEY as `0x${string}`;
}

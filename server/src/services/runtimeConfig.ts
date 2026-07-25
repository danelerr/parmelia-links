import { isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
	getNetworkConfig,
	isContractDeployed,
	isSupportedChainKey,
	type SupportedChainKey,
} from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { validateWebhookKeyring } from "./webhookSecrets";

export type RuntimeConfigIssue = {
	code: string;
	message: string;
};

function issue(code: string, message: string): RuntimeConfigIssue {
	return { code, message };
}

function validHttpUrl(value: string, requireHttps: boolean): boolean {
	try {
		const url = new URL(value);
		return requireHttps ? url.protocol === "https:" : url.protocol === "https:" || url.protocol === "http:";
	} catch {
		return false;
	}
}

function configuredPrivateKey(value: string | undefined): `0x${string}` | null {
	if (!value) return null;
	try {
		privateKeyToAccount(value as `0x${string}`);
		return value as `0x${string}`;
	} catch {
		return null;
	}
}

function validateRpcMap(raw: string | undefined): boolean {
	if (!raw) return true;
	try {
		const parsed = JSON.parse(raw) as unknown;
		return Boolean(
			parsed &&
				typeof parsed === "object" &&
				!Array.isArray(parsed) &&
				Object.entries(parsed).every(
					([chainId, url]) => /^\d+$/.test(chainId) && typeof url === "string" && validHttpUrl(url, false),
				),
		);
	} catch {
		return false;
	}
}

/** Validate configuration without exposing any secret values. */
export function validateRuntimeConfig(env: Bindings): RuntimeConfigIssue[] {
	const issues: RuntimeConfigIssue[] = [];
	const chainKey = env.CHAIN_KEY;
	if (!chainKey || !isSupportedChainKey(chainKey)) {
		return [issue("CHAIN_KEY_INVALID", "CHAIN_KEY is missing or unsupported")];
	}

	const network = getNetworkConfig(chainKey as SupportedChainKey);
	const mainnet = !network.isTestnet;
	const rpcUrls = env.RPC_URL?.split(",").map((url) => url.trim()).filter(Boolean) ?? [];
	if (rpcUrls.length === 0 || rpcUrls.some((url) => !validHttpUrl(url, false))) {
		issues.push(issue("RPC_URL_INVALID", "RPC_URL must contain one or more HTTP(S) endpoints"));
	}
	if (!env.FIREBASE_PROJECT_ID?.trim()) {
		issues.push(issue("FIREBASE_PROJECT_ID_MISSING", "FIREBASE_PROJECT_ID is required"));
	}
	if (!configuredPrivateKey(env.PRIVATE_KEY)) {
		issues.push(issue("PRIVATE_KEY_INVALID", "PRIVATE_KEY is missing or invalid"));
	}
	if (!validateRpcMap(env.CCTP_RPC_URLS)) {
		issues.push(issue("CCTP_RPC_URLS_INVALID", "CCTP_RPC_URLS must be a JSON map of chain id to HTTP(S) URL"));
	}

	if (env.APP_URL && !validHttpUrl(env.APP_URL, mainnet)) {
		issues.push(issue("APP_URL_INVALID", `APP_URL must be a valid ${mainnet ? "HTTPS" : "HTTP(S)"} URL`));
	}
	if (env.PARMELIA_FEES_ENABLED === "true" && !isAddress(env.PARMELIA_TREASURY_ADDRESS ?? "")) {
		issues.push(issue("TREASURY_INVALID", "A valid PARMELIA_TREASURY_ADDRESS is required when fees are enabled"));
	}

	try {
		const keyring = validateWebhookKeyring(env);
		if (mainnet && !keyring.activeKeyId) {
			issues.push(issue("WEBHOOK_KEY_MISSING", "WEBHOOK_SECRET_ENCRYPTION_KEY is required on mainnet"));
		}
	} catch (error) {
		issues.push(issue("WEBHOOK_KEYRING_INVALID", error instanceof Error ? error.message : "Invalid webhook keyring"));
	}

	if (!mainnet) return issues;

	const origins = env.ALLOWED_ORIGINS?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
	if (
		origins.length === 0 ||
		origins.some((origin) => {
			try {
				const url = new URL(origin);
				return url.protocol !== "https:" || url.origin !== origin;
			} catch {
				return true;
			}
		})
	) {
		issues.push(issue("CORS_ALLOWLIST_INVALID", "Mainnet requires exact HTTPS origins in ALLOWED_ORIGINS"));
	}
	if (!env.APP_URL) issues.push(issue("APP_URL_MISSING", "APP_URL must be explicit on mainnet"));
	if (!env.TURNSTILE_SECRET_KEY?.trim()) {
		issues.push(issue("TURNSTILE_MISSING", "TURNSTILE_SECRET_KEY is required on mainnet"));
	}

	const requiredContracts = ["factory", "paymaster", "verifier", "paymentRouter", "crosschainRouter"] as const;
	for (const name of requiredContracts) {
		if (!isContractDeployed(network.contracts[name])) {
			issues.push(issue("CONTRACT_NOT_DEPLOYED", `${name} is not deployed on ${network.name}`));
		}
	}

	const roleKeys: Array<readonly [string, string | undefined]> = [
		["PRIVATE_KEY", env.PRIVATE_KEY],
		["PAYMASTER_SIGNER_PRIVATE_KEY", env.PAYMASTER_SIGNER_PRIVATE_KEY],
		["PAYMENT_ROUTER_SIGNER_PRIVATE_KEY", env.PAYMENT_ROUTER_SIGNER_PRIVATE_KEY],
		["RECOVERY_GUARDIAN_PRIVATE_KEY", env.RECOVERY_GUARDIAN_PRIVATE_KEY],
	];
	if (env.FAUCET_ENABLED === "true" || env.FAUCET_PRIVATE_KEY?.trim()) {
		roleKeys.push(["FAUCET_PRIVATE_KEY", env.FAUCET_PRIVATE_KEY]);
	}
	const addresses = new Map<string, string>();
	for (const [role, value] of roleKeys) {
		const key = configuredPrivateKey(value);
		if (!key) {
			issues.push(issue("DEDICATED_KEY_INVALID", `${role} is required and must be a valid private key on mainnet`));
			continue;
		}
		const address = privateKeyToAccount(key).address.toLowerCase();
		const existingRole = addresses.get(address);
		if (existingRole) {
			issues.push(issue("SIGNING_KEYS_NOT_DISTINCT", `${role} must not share an account with ${existingRole}`));
		} else {
			addresses.set(address, role);
		}
	}

	return issues;
}

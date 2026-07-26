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

function parseRpcUrls(raw: string | undefined): string[] {
	return raw?.split(",").map((url) => url.trim()).filter(Boolean) ?? [];
}

function isAlchemyRpcUrl(value: string): boolean {
	try {
		const hostname = new URL(value).hostname.toLowerCase();
		return (
			hostname === "alchemy.com" ||
			hostname.endsWith(".alchemy.com") ||
			hostname === "alchemyapi.io" ||
			hostname.endsWith(".alchemyapi.io")
		);
	} catch {
		return false;
	}
}

function validOptionalInteger(
	raw: string | undefined,
	min: number,
	max: number,
): boolean {
	if (raw === undefined || raw.trim() === "") return true;
	const parsed = Number(raw);
	return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max;
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
	const rpcUrls = parseRpcUrls(env.RPC_URL);
	if (rpcUrls.length === 0 || rpcUrls.some((url) => !validHttpUrl(url, false))) {
		issues.push(issue("RPC_URL_INVALID", "RPC_URL must contain one or more HTTP(S) endpoints"));
	}
	for (const [role, raw] of [
		["READ", env.RPC_READ_URLS],
		["WRITE", env.RPC_WRITE_URLS],
		["INDEXER", env.RPC_INDEXER_URLS],
		["ARCHIVE", env.RPC_ARCHIVE_URLS],
		["BUNDLER", env.BUNDLER_RPC_URLS],
	] as const) {
		const urls = parseRpcUrls(raw);
		if (raw !== undefined && (urls.length === 0 || urls.some((url) => !validHttpUrl(url, false)))) {
			issues.push(issue(`RPC_${role}_URLS_INVALID`, `RPC_${role}_URLS must contain HTTP(S) endpoints`));
		}
	}
	if (!validOptionalInteger(env.RPC_TIMEOUT_MS, 1_000, 30_000)) {
		issues.push(issue("RPC_TIMEOUT_INVALID", "RPC_TIMEOUT_MS must be between 1000 and 30000"));
	}
	if (!validOptionalInteger(env.RPC_INDEXER_MIN_BLOCK_RANGE, 1, 2_000)) {
		issues.push(issue("RPC_INDEXER_MIN_RANGE_INVALID", "RPC_INDEXER_MIN_BLOCK_RANGE must be between 1 and 2000"));
	}
	if (!validOptionalInteger(env.RPC_INDEXER_MAX_BLOCK_RANGE, 1, 2_000)) {
		issues.push(issue("RPC_INDEXER_MAX_RANGE_INVALID", "RPC_INDEXER_MAX_BLOCK_RANGE must be between 1 and 2000"));
	}
	const minRange = Number(env.RPC_INDEXER_MIN_BLOCK_RANGE ?? 10);
	const maxRange = Number(env.RPC_INDEXER_MAX_BLOCK_RANGE ?? 2_000);
	if (Number.isSafeInteger(minRange) && Number.isSafeInteger(maxRange) && minRange > maxRange) {
		issues.push(issue("RPC_INDEXER_RANGE_ORDER_INVALID", "RPC indexer min range cannot exceed max range"));
	}
	// `fallback()` retries the exact same request against the next URL. Every
	// endpoint in the indexer role therefore has to support the configured hard
	// maximum. Alchemy Free supports only ten blocks for eth_getLogs on
	// Arbitrum; mixing it with a 2,000-block public endpoint would otherwise
	// fail precisely during provider degradation.
	const effectiveIndexerUrls = parseRpcUrls(
		env.RPC_INDEXER_URLS?.trim() ? env.RPC_INDEXER_URLS : env.RPC_URL,
	);
	const alchemyInIndexer = effectiveIndexerUrls.some(isAlchemyRpcUrl);
	if (alchemyInIndexer && Number.isSafeInteger(maxRange) && maxRange > 10) {
		issues.push(issue(
			"RPC_INDEXER_ALCHEMY_RANGE_INVALID",
			"Alchemy in the indexer role requires RPC_INDEXER_MAX_BLOCK_RANGE <= 10",
		));
	}
	if (!validOptionalInteger(env.INDEXER_WALLET_SHARD_SIZE, 1, 500)) {
		issues.push(issue("INDEXER_SHARD_SIZE_INVALID", "INDEXER_WALLET_SHARD_SIZE must be between 1 and 500"));
	}
	if (!validOptionalInteger(env.BALANCE_MAX_STALENESS_SECONDS, 15, 86_400)) {
		issues.push(issue("BALANCE_STALENESS_INVALID", "BALANCE_MAX_STALENESS_SECONDS must be between 15 and 86400"));
	}
	if (
		!validOptionalInteger(
			env.BALANCE_RPC_ONLY_REFRESH_SECONDS,
			60,
			86_400,
		)
	) {
		issues.push(issue(
			"BALANCE_RPC_ONLY_REFRESH_INVALID",
			"BALANCE_RPC_ONLY_REFRESH_SECONDS must be between 60 and 86400",
		));
	}
	if (!validOptionalInteger(env.BALANCE_MAINTENANCE_BATCH_SIZE, 1, 100)) {
		issues.push(issue(
			"BALANCE_MAINTENANCE_BATCH_INVALID",
			"BALANCE_MAINTENANCE_BATCH_SIZE must be between 1 and 100",
		));
	}
	if (!validOptionalInteger(env.ARBITRUM_L1_CONFIRMATIONS_REQUIRED, 1, 256)) {
		issues.push(issue(
			"ARBITRUM_L1_CONFIRMATIONS_INVALID",
			"ARBITRUM_L1_CONFIRMATIONS_REQUIRED must be between 1 and 256",
		));
	}
	if (
		env.RELAYER_MODE !== undefined &&
		!["self", "bundler"].includes(env.RELAYER_MODE)
	) {
		issues.push(issue(
			"RELAYER_MODE_INVALID",
			"RELAYER_MODE must be self or bundler",
		));
	}
	if (!validOptionalInteger(env.BUNDLER_ROLLOUT_PERCENT, 0, 100)) {
		issues.push(issue(
			"BUNDLER_ROLLOUT_INVALID",
			"BUNDLER_ROLLOUT_PERCENT must be between 0 and 100",
		));
	}
	if (
		env.BUNDLER_SELF_FALLBACK !== undefined &&
		!["true", "false"].includes(env.BUNDLER_SELF_FALLBACK)
	) {
		issues.push(issue(
			"BUNDLER_SELF_FALLBACK_INVALID",
			"BUNDLER_SELF_FALLBACK must be true or false",
		));
	}
	if (
		env.BUNDLER_DUMMY_SIGNATURE !== undefined &&
		(!/^0x[0-9a-fA-F]*$/u.test(env.BUNDLER_DUMMY_SIGNATURE) ||
			env.BUNDLER_DUMMY_SIGNATURE.length > 16_386)
	) {
		issues.push(issue(
			"BUNDLER_DUMMY_SIGNATURE_INVALID",
			"BUNDLER_DUMMY_SIGNATURE must be bounded hex bytes",
		));
	}
	if (
		env.RELAYER_MODE === "bundler" &&
		parseRpcUrls(env.BUNDLER_RPC_URLS).length === 0
	) {
		issues.push(issue(
			"BUNDLER_RPC_URLS_MISSING",
			"BUNDLER_RPC_URLS is required when RELAYER_MODE=bundler",
		));
	}
	if (
		env.RELAYER_MODE === "bundler" &&
		Number(env.BUNDLER_ROLLOUT_PERCENT ?? "100") > 0 &&
		(!env.BUNDLER_DUMMY_SIGNATURE ||
			env.BUNDLER_DUMMY_SIGNATURE === "0x")
	) {
		issues.push(issue(
			"BUNDLER_DUMMY_SIGNATURE_MISSING",
			"A non-empty account-compatible dummy signature is required for bundler gas estimation",
		));
	}
	if (env.ALCHEMY_WEBHOOK_ENABLED === "true") {
		if (!env.ALCHEMY_WEBHOOK_SIGNING_KEY?.trim()) {
			issues.push(issue("ALCHEMY_WEBHOOK_SIGNING_KEY_MISSING", "Alchemy webhook signing key is required when enabled"));
		}
		if (!env.ALCHEMY_WEBHOOK_ID?.trim()) {
			issues.push(issue("ALCHEMY_WEBHOOK_ID_MISSING", "Alchemy webhook id is required when enabled"));
		}
		if (!env.ALCHEMY_WEBHOOK_NETWORK?.trim()) {
			issues.push(issue("ALCHEMY_WEBHOOK_NETWORK_MISSING", "Alchemy webhook network is required when enabled"));
		}
		if (!env.ALCHEMY_NOTIFY_AUTH_TOKEN?.trim()) {
			issues.push(issue(
				"ALCHEMY_NOTIFY_AUTH_TOKEN_MISSING",
				"Alchemy Notify auth token is required to synchronize tracked wallet addresses",
			));
		}
		if (parseRpcUrls(env.RPC_INDEXER_URLS).length === 0) {
			issues.push(issue(
				"RPC_INDEXER_URLS_MISSING",
				"Alchemy push requires an explicit independent RPC_INDEXER_URLS reconciliation endpoint",
			));
		}
		if (parseRpcUrls(env.RPC_INDEXER_URLS).some(isAlchemyRpcUrl)) {
			issues.push(issue(
				"RPC_INDEXER_NOT_INDEPENDENT",
				"Alchemy webhook events must be reconciled through a non-Alchemy RPC_INDEXER_URLS endpoint",
			));
		}
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

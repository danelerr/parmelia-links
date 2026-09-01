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
import {
	RPC_ROLE_NAMES,
	validateRpcProviderCapabilities,
	type RpcRoleName,
} from "./rpcProviders";
import {
	getAlchemyAddressWebhookConfigs,
	validateAlchemyAddressWebhookConfigs,
} from "./alchemyWebhookConfig";
import { sponsorshipProviderNames, validateSponsorshipConfig } from "./sponsorship";
import { originMatchesPasskeyRpId, validPasskeyRpId } from "./passkeyConfig";

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

function validExactOrigin(value: string, requireHttps: boolean): boolean {
	try {
		const url = new URL(value);
		return url.origin === value && validHttpUrl(value, requireHttps);
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

type AppChainRpcRoles = {
	read?: string;
	write?: string;
	indexer?: string;
	archive?: string;
	bundler?: string;
};

type AppChainRpcMap = Record<string, string | AppChainRpcRoles>;

function validRpcUrlList(value: unknown): value is string {
	return typeof value === "string" &&
		parseRpcUrls(value).length > 0 &&
		parseRpcUrls(value).every((url) => validHttpUrl(url, false));
}

function parseAppChainRpcMap(raw: string | undefined): AppChainRpcMap | null {
	if (!raw?.trim()) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const entries = Object.entries(parsed as Record<string, unknown>);
		for (const [chainId, value] of entries) {
			if (!/^\d+$/u.test(chainId)) return null;
			if (typeof value === "string") {
				if (!validRpcUrlList(value)) return null;
				continue;
			}
			if (!value || typeof value !== "object" || Array.isArray(value)) return null;
			const roles = Object.entries(value as Record<string, unknown>);
			if (roles.length === 0 || roles.some(([role, urls]) =>
				!["read", "write", "indexer", "archive", "bundler"].includes(role) ||
				!validRpcUrlList(urls)
			)) return null;
		}
		return parsed as AppChainRpcMap;
	} catch {
		return null;
	}
}

function chainList(raw: string | undefined, fallback: string): string[] {
	return (raw?.trim() || fallback)
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
}

export function validateAppMultichainConfig(env: Bindings): RuntimeConfigIssue[] {
	const issues: RuntimeConfigIssue[] = [];
	const home = env.CHAIN_KEY;
	const enabled = chainList(env.APP_ENABLED_CHAIN_KEYS, home);
	const walletRails = chainList(env.APP_WALLET_RAIL_CHAIN_KEYS, home);
	const validEnabled = enabled.every(isSupportedChainKey) && new Set(enabled).size === enabled.length;
	const validWalletRails = walletRails.every(isSupportedChainKey) && new Set(walletRails).size === walletRails.length;
	if (!validEnabled) {
		issues.push(issue("APP_ENABLED_CHAINS_INVALID", "APP_ENABLED_CHAIN_KEYS must be a unique list of supported chain keys"));
	}
	if (!validWalletRails) {
		issues.push(issue("APP_WALLET_RAIL_CHAINS_INVALID", "APP_WALLET_RAIL_CHAIN_KEYS must be a unique list of supported chain keys"));
	}
	if (!enabled.includes(home)) {
		issues.push(issue("APP_HOME_CHAIN_MISSING", "APP_ENABLED_CHAIN_KEYS must include CHAIN_KEY"));
	}
	if (validEnabled && validWalletRails && walletRails.some((key) =>
		!enabled.includes(key) || !getNetworkConfig(key as SupportedChainKey).walletRailEnabled
	)) {
		issues.push(issue("APP_WALLET_RAIL_NOT_ENABLED", "Every wallet rail must be enabled and supported by its network manifest"));
	}

	const appRpcMap = parseAppChainRpcMap(env.APP_CHAIN_RPC_URLS);
	if (appRpcMap === null) {
		issues.push(issue("APP_CHAIN_RPC_URLS_INVALID", "APP_CHAIN_RPC_URLS must map chain ids to HTTP(S) URL lists or read/write/indexer/archive/bundler role objects"));
		return issues;
	}
	const cctpRpcMap = parseAppChainRpcMap(env.CCTP_RPC_URLS);
	const supportedChainIds = new Set(
		enabled.filter(isSupportedChainKey).map((key) => String(getNetworkConfig(key).chainId)),
	);
	if (Object.keys(appRpcMap).some((chainId) => !supportedChainIds.has(chainId))) {
		issues.push(issue("APP_CHAIN_RPC_UNKNOWN_CHAIN", "APP_CHAIN_RPC_URLS contains a chain that is not enabled for the App"));
	}
	if (validWalletRails) {
		for (const key of walletRails.filter(isSupportedChainKey)) {
			if (key === home) continue;
			const chainId = String(getNetworkConfig(key).chainId);
			const entry = appRpcMap[chainId] ?? cctpRpcMap?.[chainId];
			if (!entry) {
				issues.push(issue("APP_CHAIN_RPC_MISSING", `An RPC configuration is required for the enabled wallet rail ${key}`));
				continue;
			}
			if (env.RELAYER_MODE === "bundler" &&
				(typeof entry === "string" || !entry.bundler?.trim())) {
				issues.push(issue("APP_CHAIN_BUNDLER_RPC_MISSING", `A bundler RPC is required for the enabled wallet rail ${key}`));
			}
		}
	}
	return issues;
}

function parseRpcUrls(raw: string | undefined): string[] {
	return raw?.split(",").map((url) => url.trim()).filter(Boolean) ?? [];
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

function configuredFeeBps(raw: string | undefined): bigint | null {
	if (raw === undefined || raw.trim() === "") return 0n;
	if (!/^\d+$/u.test(raw)) return null;
	try {
		const value = BigInt(raw);
		return value >= 0n && value <= 100n ? value : null;
	} catch { return null; }
}

export function validatePasskeySecurityConfig(
	env: Bindings,
	options: { requireExplicit?: boolean; requireHttps?: boolean } = {},
): RuntimeConfigIssue[] {
	const issues: RuntimeConfigIssue[] = [];
	const rpId = env.PASSKEY_RP_ID?.trim().toLowerCase();
	const developmentOnlyRpId = rpId === "localhost" || /^127(?:\.\d{1,3}){3}$/u.test(rpId ?? "");
	const productionScope = options.requireHttps ?? options.requireExplicit === true;
	if (!rpId) {
		if (options.requireExplicit) {
			issues.push(issue("PASSKEY_RP_ID_MISSING", "PASSKEY_RP_ID must be configured explicitly"));
		}
	} else if (!validPasskeyRpId(rpId) || (productionScope && developmentOnlyRpId)) {
		issues.push(issue("PASSKEY_RP_ID_INVALID", "PASSKEY_RP_ID must be a non-local hostname without scheme, port, or path in production"));
	}

	const rawOrigins = env.PASSKEY_ALLOWED_ORIGINS?.trim();
	const origins = rawOrigins?.split(",").map((origin) => origin.trim()).filter(Boolean) ?? [];
	if (origins.length === 0) {
		if (options.requireExplicit) {
			issues.push(issue("PASSKEY_ORIGINS_MISSING", "PASSKEY_ALLOWED_ORIGINS must be configured explicitly"));
		}
		return issues;
	}

	const invalidOrigin = origins.some((origin) =>
		!validExactOrigin(origin, productionScope) ||
		(Boolean(rpId) && validPasskeyRpId(rpId) && !originMatchesPasskeyRpId(origin, rpId!)),
	);
	if (invalidOrigin) {
		issues.push(issue(
			"PASSKEY_ORIGINS_INVALID",
			"PASSKEY_ALLOWED_ORIGINS must contain exact compatible origins for PASSKEY_RP_ID",
		));
	}
	return issues;
}

/** Dependencies required by Firebase magic links and recovery step-up proofs. */
export function validateEmailSecurityConfig(env: Bindings): RuntimeConfigIssue[] {
	const issues: RuntimeConfigIssue[] = [];
	if (!env.AUTH_CODE_PEPPER?.trim() || env.AUTH_CODE_PEPPER.trim().length < 32) {
		issues.push(issue("AUTH_CODE_PEPPER_INVALID", "AUTH_CODE_PEPPER must contain at least 32 characters"));
	}
	const rawServiceAccount = env.FIREBASE_SERVICE_ACCOUNT?.trim() || env.FCM_SERVICE_ACCOUNT?.trim();
	if (!rawServiceAccount) {
		issues.push(issue("FIREBASE_ADMIN_MISSING", "FIREBASE_SERVICE_ACCOUNT is required for recovery email links"));
	} else {
		try {
			const account = JSON.parse(rawServiceAccount) as Record<string, unknown>;
			if (
				account.project_id !== env.FIREBASE_PROJECT_ID ||
				typeof account.client_email !== "string" ||
				!account.client_email ||
				typeof account.private_key !== "string" ||
				!account.private_key ||
				account.token_uri !== "https://oauth2.googleapis.com/token"
			) {
				throw new Error("invalid");
			}
		} catch {
			issues.push(issue("FIREBASE_ADMIN_INVALID", "Firebase service-account JSON must match FIREBASE_PROJECT_ID"));
		}
	}
	if (!env.FIREBASE_WEB_API_KEY?.trim()) {
		issues.push(issue("FIREBASE_WEB_API_KEY_MISSING", "FIREBASE_WEB_API_KEY is required for Firebase email links"));
	}
	if (!env.APP_URL?.trim() || !validExactOrigin(env.APP_URL, true)) {
		issues.push(issue("APP_URL_INVALID", "APP_URL must be the HTTPS origin authorized by Firebase"));
	}
	return issues;
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
	issues.push(...validatePasskeySecurityConfig(env, {
		requireExplicit: true,
		requireHttps: mainnet,
	}));
	issues.push(...validateAppMultichainConfig(env));
	for (const code of validateSponsorshipConfig(env)) {
		issues.push(issue(code, "Sponsorship provider configuration is invalid"));
	}
	if (env.SPONSORSHIP_HEALTH_CHECK_ENABLED !== undefined &&
		!["true", "false"].includes(env.SPONSORSHIP_HEALTH_CHECK_ENABLED)) {
		issues.push(issue("SPONSORSHIP_HEALTH_CHECK_INVALID",
			"SPONSORSHIP_HEALTH_CHECK_ENABLED must be true or false"));
	}
	if (env.PAYMASTER_MIN_DEPOSIT_WEI !== undefined &&
		(!/^\d+$/u.test(env.PAYMASTER_MIN_DEPOSIT_WEI) || BigInt(env.PAYMASTER_MIN_DEPOSIT_WEI) > 10n ** 30n)) {
		issues.push(issue("PAYMASTER_MIN_DEPOSIT_INVALID", "PAYMASTER_MIN_DEPOSIT_WEI is invalid"));
	}
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
	const roleUrls: Record<RpcRoleName, string[]> = {
		read: parseRpcUrls(env.RPC_READ_URLS?.trim() ? env.RPC_READ_URLS : env.RPC_URL),
		write: parseRpcUrls(env.RPC_WRITE_URLS?.trim() ? env.RPC_WRITE_URLS : env.RPC_URL),
		indexer: parseRpcUrls(env.RPC_INDEXER_URLS?.trim() ? env.RPC_INDEXER_URLS : env.RPC_URL),
		archive: parseRpcUrls(
			env.RPC_ARCHIVE_URLS?.trim()
				? env.RPC_ARCHIVE_URLS
				: env.RPC_INDEXER_URLS?.trim()
					? env.RPC_INDEXER_URLS
					: env.RPC_URL,
		),
		bundler: parseRpcUrls(env.BUNDLER_RPC_URLS),
	};
	for (const capabilityIssue of validateRpcProviderCapabilities(
		env,
		Object.fromEntries(
			RPC_ROLE_NAMES.map((role) => [role, roleUrls[role].length]),
		),
	)) {
		issues.push(issue(capabilityIssue.code, capabilityIssue.message));
	}
	if (!validOptionalInteger(env.RPC_TIMEOUT_MS, 1_000, 30_000)) {
		issues.push(issue("RPC_TIMEOUT_INVALID", "RPC_TIMEOUT_MS must be between 1000 and 30000"));
	}
	if (!validOptionalInteger(env.RPC_INDEXER_MIN_BLOCK_RANGE, 1, 10_000_000)) {
		issues.push(issue("RPC_INDEXER_MIN_RANGE_INVALID", "RPC_INDEXER_MIN_BLOCK_RANGE must be between 1 and 10000000"));
	}
	if (!validOptionalInteger(env.RPC_INDEXER_MAX_BLOCK_RANGE, 1, 10_000_000)) {
		issues.push(issue("RPC_INDEXER_MAX_RANGE_INVALID", "RPC_INDEXER_MAX_BLOCK_RANGE must be between 1 and 10000000"));
	}
	const minRange = Number(env.RPC_INDEXER_MIN_BLOCK_RANGE ?? 10);
	const maxRange = Number(env.RPC_INDEXER_MAX_BLOCK_RANGE ?? 2_000);
	if (Number.isSafeInteger(minRange) && Number.isSafeInteger(maxRange) && minRange > maxRange) {
		issues.push(issue("RPC_INDEXER_RANGE_ORDER_INVALID", "RPC indexer min range cannot exceed max range"));
	}
	if (!validOptionalInteger(env.INDEXER_WALLET_SHARD_SIZE, 1, 500)) {
		issues.push(issue("INDEXER_SHARD_SIZE_INVALID", "INDEXER_WALLET_SHARD_SIZE must be between 1 and 500"));
	}
	if (!validOptionalInteger(env.INDEXER_REGISTRY_BATCH_SIZE, 1, 250)) {
		issues.push(issue(
			"INDEXER_REGISTRY_BATCH_INVALID",
			"INDEXER_REGISTRY_BATCH_SIZE must be between 1 and 250",
		));
	}
	if (!validOptionalInteger(env.INDEXER_MAX_RPC_CALLS_PER_JOB, 1, 1_000)) {
		issues.push(issue(
			"INDEXER_RPC_BUDGET_INVALID",
			"INDEXER_MAX_RPC_CALLS_PER_JOB must be between 1 and 1000",
		));
	}
	if (!validOptionalInteger(env.INDEXER_MAX_BLOCKS_PER_JOB, 1, 10_000_000)) {
		issues.push(issue(
			"INDEXER_BLOCK_BUDGET_INVALID",
			"INDEXER_MAX_BLOCKS_PER_JOB must be between 1 and 10000000",
		));
	}
	if (!validOptionalInteger(env.INDEXER_MAX_EVENT_BLOCKS_PER_JOB, 1, 100)) {
		issues.push(issue(
			"INDEXER_EVENT_BLOCK_BUDGET_INVALID",
			"INDEXER_MAX_EVENT_BLOCKS_PER_JOB must be between 1 and 100",
		));
	}
	if (!validOptionalInteger(env.INDEXER_SAFETY_SWEEP_SECONDS, 60, 86_400)) {
		issues.push(issue(
			"INDEXER_SAFETY_SWEEP_INVALID",
			"INDEXER_SAFETY_SWEEP_SECONDS must be between 60 and 86400",
		));
	}
	if (!validOptionalInteger(env.BALANCE_MAX_STALENESS_SECONDS, 15, 86_400)) {
		issues.push(issue("BALANCE_STALENESS_INVALID", "BALANCE_MAX_STALENESS_SECONDS must be between 15 and 86400"));
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
		for (const webhookIssue of validateAlchemyAddressWebhookConfigs(env)) {
			issues.push(issue(webhookIssue.code, webhookIssue.message));
		}
		if (getAlchemyAddressWebhookConfigs(env).length === 0) {
			issues.push(issue(
				"ALCHEMY_ADDRESS_WEBHOOK_CONFIG_MISSING",
				"At least one Alchemy Address Activity webhook is required when enabled",
			));
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
				"Alchemy push requires an explicit RPC_INDEXER_URLS reconciliation pool",
			));
		}
	}
	if (env.ALCHEMY_CUSTOM_WEBHOOK_ENABLED === "true") {
		if (!env.ALCHEMY_CUSTOM_WEBHOOK_SIGNING_KEY?.trim()) {
			issues.push(issue(
				"ALCHEMY_CUSTOM_WEBHOOK_SIGNING_KEY_MISSING",
				"Alchemy Custom Webhook signing key is required when enabled",
			));
		}
		if (!env.ALCHEMY_CUSTOM_WEBHOOK_ID?.trim()) {
			issues.push(issue(
				"ALCHEMY_CUSTOM_WEBHOOK_ID_MISSING",
				"Alchemy Custom Webhook id is required when enabled",
			));
		}
		if (parseRpcUrls(env.RPC_INDEXER_URLS).length === 0) {
			issues.push(issue(
				"RPC_INDEXER_URLS_MISSING",
				"Alchemy Custom Webhook requires an explicit RPC_INDEXER_URLS reconciliation pool",
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
	if (env.GATOPAGO_FEES_ENABLED !== undefined &&
		!['true', 'false'].includes(env.GATOPAGO_FEES_ENABLED)) {
		issues.push(issue("FEE_SWITCH_INVALID", "GATOPAGO_FEES_ENABLED must be true or false"));
	}
	if (env.GATOPAGO_FEES_ENABLED === "true") {
		const cap = configuredFeeBps(env.GATOPAGO_MAX_FEE_BPS ?? "100");
		const productFees = [env.GATOPAGO_SWAP_FEE_BPS, env.GATOPAGO_CROSSCHAIN_FEE_BPS]
			.map(configuredFeeBps);
		if (cap === null || productFees.some((value) => value === null || (cap !== null && value! > cap))) {
			issues.push(issue("FEE_POLICY_INVALID",
				"App fee basis points must be integers between 0 and the configured cap (maximum 100)"));
		}
		if (productFees.some((value) => value !== null && value > 0n) &&
			!isAddress(env.GATOPAGO_TREASURY_ADDRESS ?? "")) {
			issues.push(issue("TREASURY_INVALID", "A valid GATOPAGO_TREASURY_ADDRESS is required when a fee is nonzero"));
		}
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

	if (env.ALCHEMY_CUSTOM_WEBHOOK_ENABLED !== "true") {
		issues.push(issue(
			"ALCHEMY_CUSTOM_WEBHOOK_REQUIRED",
			"Mainnet requires the event-driven Custom Webhook for router and recovery events",
		));
	}

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
	issues.push(...validateEmailSecurityConfig(env));

	const requiredContracts = ["factory", "verifier", "paymentRouter", "crosschainRouter"] as const;
	for (const name of requiredContracts) {
		if (!isContractDeployed(network.contracts[name])) {
			issues.push(issue("CONTRACT_NOT_DEPLOYED", `${name} is not deployed on ${network.name}`));
		}
	}
	if (sponsorshipProviderNames(env).includes("parmelia") && !isContractDeployed(
		env.SPONSORSHIP_PAYMASTER_ADDRESS as `0x${string}` | undefined ?? network.contracts.paymaster)) {
		issues.push(issue("CONTRACT_NOT_DEPLOYED", `paymaster is not deployed on ${network.name}`));
	}

	const roleKeys: Array<readonly [string, string | undefined]> = [
		["PRIVATE_KEY", env.PRIVATE_KEY],
		["PAYMENT_ROUTER_SIGNER_PRIVATE_KEY", env.PAYMENT_ROUTER_SIGNER_PRIVATE_KEY],
		["RECOVERY_GUARDIAN_PRIVATE_KEY", env.RECOVERY_GUARDIAN_PRIVATE_KEY],
	];
	if (sponsorshipProviderNames(env).includes("parmelia")) {
		roleKeys.push(["PAYMASTER_SIGNER_PRIVATE_KEY", env.PAYMASTER_SIGNER_PRIVATE_KEY]);
	}
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

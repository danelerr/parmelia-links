import {
	concat,
	encodePacked,
	getAddress,
	isAddress,
	isHex,
	toHex,
	type Address,
	type Hex,
} from "viem";
import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { discardResponseBody, readJsonBounded } from "./http";
import { getPaymasterSignerKey } from "./keys";
import { logWarn } from "./logger";
import {
	buildSignedPaymasterAndData,
	PAYMASTER_POST_OP_GAS_LIMIT,
	PAYMASTER_VERIFICATION_GAS_LIMIT,
} from "./paymaster";
import { packedUserOperationToRpc } from "./userOperationTransport";
import type { PackedUserOp } from "./userOp";

export type SponsorshipProviderName = "parmelia" | "erc7677" | "self-funded";

type SponsorshipInput = {
	env: Bindings;
	chainId: number;
	entryPoint: Address;
	userOp: PackedUserOp;
	paymasterVerificationGasLimit?: bigint;
	paymasterPostOpGasLimit?: bigint;
};

type PreparedSponsorship = {
	paymasterAndData: Hex;
	isFinal: boolean;
};

export interface SponsorshipProvider {
	readonly name: SponsorshipProviderName;
	prepare(input: SponsorshipInput): Promise<PreparedSponsorship>;
	finalize(input: SponsorshipInput, prepared: PreparedSponsorship): Promise<Hex>;
}

class SponsorshipError extends Error {
	constructor(readonly provider: SponsorshipProviderName, message: string) {
		super(message);
		this.name = "SponsorshipError";
	}
}

type PaymasterServiceResult = {
	paymaster?: unknown;
	paymasterData?: unknown;
	paymasterAndData?: unknown;
	paymasterVerificationGasLimit?: unknown;
	paymasterPostOpGasLimit?: unknown;
	isFinal?: unknown;
};

type JsonRpcResponse = {
	jsonrpc?: unknown;
	id?: unknown;
	result?: PaymasterServiceResult;
	error?: { code?: unknown; message?: unknown };
};

function providerName(value: string | undefined, fallback: SponsorshipProviderName): SponsorshipProviderName {
	if (value === undefined || value.trim() === "") return fallback;
	if (value === "parmelia" || value === "erc7677" || value === "self-funded") return value;
	throw new Error(`Unsupported sponsorship provider: ${value}`);
}

export function sponsorshipProviderNames(env: Bindings): SponsorshipProviderName[] {
	const primary = providerName(env.SPONSORSHIP_PROVIDER, "parmelia");
	const fallback = env.SPONSORSHIP_FALLBACK_PROVIDER
		? providerName(env.SPONSORSHIP_FALLBACK_PROVIDER, primary)
		: null;
	return fallback && fallback !== primary ? [primary, fallback] : [primary];
}

function configuredParmeliaPaymaster(env: Bindings): Address {
	const configured = env.SPONSORSHIP_PAYMASTER_ADDRESS?.trim() ||
		getNetworkConfig(env.CHAIN_KEY).contracts.paymaster;
	if (!isAddress(configured)) throw new SponsorshipError("parmelia", "Parmelia paymaster address is invalid");
	return getAddress(configured);
}

class ParmeliaSponsorshipProvider implements SponsorshipProvider {
	readonly name = "parmelia" as const;

	async prepare(input: SponsorshipInput): Promise<PreparedSponsorship> {
		return { paymasterAndData: await this.signed(input), isFinal: false };
	}

	async finalize(input: SponsorshipInput): Promise<Hex> {
		return this.signed(input);
	}

	private async signed(input: SponsorshipInput): Promise<Hex> {
		try {
			return await buildSignedPaymasterAndData({ chainId: input.chainId,
				paymasterAddress: configuredParmeliaPaymaster(input.env), userOp: input.userOp,
				signerPrivateKey: getPaymasterSignerKey(input.env),
				paymasterVerificationGasLimit: input.paymasterVerificationGasLimit,
				paymasterPostOpGasLimit: input.paymasterPostOpGasLimit });
		} catch (error) {
			throw new SponsorshipError(this.name,
				error instanceof Error ? error.message : "Parmelia sponsorship failed");
		}
	}
}

class SelfFundedSponsorshipProvider implements SponsorshipProvider {
	readonly name = "self-funded" as const;
	async prepare(): Promise<PreparedSponsorship> {
		return { paymasterAndData: "0x", isFinal: true };
	}
	async finalize(): Promise<Hex> {
		return "0x";
	}
}

function serviceUrl(env: Bindings): string {
	if (!env.PAYMASTER_SERVICE_URL?.trim()) {
		throw new SponsorshipError("erc7677", "PAYMASTER_SERVICE_URL is not configured");
	}
	let url: URL;
	try {
		url = new URL(env.PAYMASTER_SERVICE_URL);
	} catch {
		throw new SponsorshipError("erc7677", "PAYMASTER_SERVICE_URL is invalid");
	}
	if (url.protocol !== "https:" || url.username || url.password || url.toString().length > 2_048) {
		throw new SponsorshipError("erc7677", "Paymaster service must use a bounded credential-free HTTPS URL");
	}
	return url.toString();
}

function serviceContext(env: Bindings): Record<string, unknown> {
	const configured = env.PAYMASTER_SERVICE_CONTEXT_JSON?.trim();
	if (!configured) return {};
	if (new TextEncoder().encode(configured).byteLength > 16 * 1024) {
		throw new SponsorshipError("erc7677", "Paymaster service context is too large");
	}
	let value: unknown;
	try {
		value = JSON.parse(configured);
	} catch {
		throw new SponsorshipError("erc7677", "Paymaster service context is malformed");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new SponsorshipError("erc7677", "Paymaster service context must be an object");
	}
	return value as Record<string, unknown>;
}

function boundedTimeout(env: Bindings): number {
	const parsed = Number(env.PAYMASTER_SERVICE_TIMEOUT_MS ?? "8000");
	if (!Number.isSafeInteger(parsed) || parsed < 1_000 || parsed > 15_000) {
		throw new SponsorshipError("erc7677", "PAYMASTER_SERVICE_TIMEOUT_MS must be between 1000 and 15000");
	}
	return parsed;
}

function unsignedRpcUserOp(userOp: PackedUserOp): Record<string, unknown> {
	const unsigned: Record<string, unknown> = { ...packedUserOperationToRpc(userOp) };
	delete unsigned.signature;
	return unsigned;
}

async function paymasterRpc(input: SponsorshipInput,
	method: "pm_getPaymasterStubData" | "pm_getPaymasterData"): Promise<PaymasterServiceResult> {
	const id = crypto.randomUUID();
	const response = await fetch(serviceUrl(input.env), {
		method: "POST",
		headers: { "Content-Type": "application/json", Accept: "application/json" },
		body: JSON.stringify({ jsonrpc: "2.0", id, method,
			params: [unsignedRpcUserOp(input.userOp), input.entryPoint, toHex(input.chainId), serviceContext(input.env)] }),
		signal: AbortSignal.timeout(boundedTimeout(input.env)),
	});
	if (!response.ok) {
		await discardResponseBody(response);
		throw new SponsorshipError("erc7677", `Paymaster service returned HTTP ${response.status}`);
	}
	const payload = await readJsonBounded<JsonRpcResponse>(response, 64 * 1024);
	if (payload.error || !payload.result || payload.id !== id) {
		throw new SponsorshipError("erc7677", "Paymaster service returned an invalid JSON-RPC response");
	}
	return payload.result;
}

function uint128(value: unknown, fallback: bigint, label: string): bigint {
	if (value === undefined) return fallback;
	if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/u.test(value)) {
		throw new SponsorshipError("erc7677", `${label} is invalid`);
	}
	const parsed = BigInt(value);
	if (parsed <= 0n || parsed > (1n << 128n) - 1n) {
		throw new SponsorshipError("erc7677", `${label} is out of range`);
	}
	return parsed;
}

function packServiceResult(env: Bindings, result: PaymasterServiceResult, input: SponsorshipInput,
	allowServiceGasLimits: boolean): Hex {
	if (result.paymasterAndData !== undefined) {
		throw new SponsorshipError("erc7677", "This EntryPoint requires split v0.7+ paymaster fields");
	}
	if (typeof result.paymaster !== "string" || !isAddress(result.paymaster) ||
		typeof result.paymasterData !== "string" || !isHex(result.paymasterData)) {
		throw new SponsorshipError("erc7677", "Paymaster service result is missing valid split fields");
	}
	const paymaster = getAddress(result.paymaster);
	if (env.PAYMASTER_SERVICE_EXPECTED_PAYMASTER) {
		if (!isAddress(env.PAYMASTER_SERVICE_EXPECTED_PAYMASTER) ||
			getAddress(env.PAYMASTER_SERVICE_EXPECTED_PAYMASTER) !== paymaster) {
			throw new SponsorshipError("erc7677", "Paymaster service returned an unexpected contract");
		}
	}
	if (!allowServiceGasLimits &&
		(result.paymasterVerificationGasLimit !== undefined || result.paymasterPostOpGasLimit !== undefined)) {
		throw new SponsorshipError("erc7677", "Final paymaster response unexpectedly changed gas fields");
	}
	const verificationGas = uint128(result.paymasterVerificationGasLimit,
		input.paymasterVerificationGasLimit ?? PAYMASTER_VERIFICATION_GAS_LIMIT,
		"paymasterVerificationGasLimit");
	const postOpGas = uint128(result.paymasterPostOpGasLimit,
		input.paymasterPostOpGasLimit ?? PAYMASTER_POST_OP_GAS_LIMIT,
		"paymasterPostOpGasLimit");
	return concat([encodePacked(["address", "uint128", "uint128"], [paymaster, verificationGas, postOpGas]),
		result.paymasterData as Hex]) as Hex;
}

class Erc7677SponsorshipProvider implements SponsorshipProvider {
	readonly name = "erc7677" as const;
	async prepare(input: SponsorshipInput): Promise<PreparedSponsorship> {
		try {
			const result = await paymasterRpc(input, "pm_getPaymasterStubData");
			return { paymasterAndData: packServiceResult(input.env, result, input, true), isFinal: result.isFinal === true };
		} catch (error) {
			if (error instanceof SponsorshipError) throw error;
			throw new SponsorshipError(this.name, error instanceof Error ? error.message : "Paymaster stub request failed");
		}
	}

	async finalize(input: SponsorshipInput, prepared: PreparedSponsorship): Promise<Hex> {
		if (prepared.isFinal) return prepared.paymasterAndData;
		try {
			const final = packServiceResult(input.env,
				await paymasterRpc(input, "pm_getPaymasterData"), input, false);
			if (sponsorshipPaymasterAddress(final) !== sponsorshipPaymasterAddress(prepared.paymasterAndData)) {
				throw new SponsorshipError(this.name, "Paymaster service changed contract after gas estimation");
			}
			if (final.length !== prepared.paymasterAndData.length) {
				throw new SponsorshipError(this.name, "Final paymaster data length differs from its estimation stub");
			}
			return final;
		} catch (error) {
			if (error instanceof SponsorshipError) throw error;
			throw new SponsorshipError(this.name, error instanceof Error ? error.message : "Paymaster final request failed");
		}
	}
}

/** Replace only the two packed uint128 gas fields after bundler estimation. */
export function withSponsorshipGasLimits(paymasterAndData: Hex,
	verificationGasLimit: bigint, postOpGasLimit: bigint): Hex {
	const maximum = (1n << 128n) - 1n;
	if (paymasterAndData.length < 106 || verificationGasLimit <= 0n || postOpGasLimit <= 0n ||
		verificationGasLimit > maximum || postOpGasLimit > maximum) {
		throw new Error("Sponsorship gas limits are invalid");
	}
	const paymaster = sponsorshipPaymasterAddress(paymasterAndData);
	if (!paymaster) throw new Error("Sponsorship paymaster is missing");
	const data = `0x${paymasterAndData.slice(106)}` as Hex;
	return concat([
		paymaster,
		encodePacked(["uint128", "uint128"], [verificationGasLimit, postOpGasLimit]),
		data,
	]) as Hex;
}

export function createSponsorshipProvider(name: SponsorshipProviderName): SponsorshipProvider {
	if (name === "erc7677") return new Erc7677SponsorshipProvider();
	if (name === "self-funded") return new SelfFundedSponsorshipProvider();
	return new ParmeliaSponsorshipProvider();
}

export function sponsorshipPaymasterAddress(paymasterAndData: Hex): Address | null {
	if (paymasterAndData === "0x") return null;
	if (!isHex(paymasterAndData) || paymasterAndData.length < 42) {
		throw new Error("Sponsorship provider returned malformed paymasterAndData");
	}
	return getAddress(`0x${paymasterAndData.slice(2, 42)}`);
}

/**
 * Fallback happens entirely while the UserOperation is still unsigned. The
 * caller must rebuild and re-estimate inside `operation` for every provider.
 */
export async function withSponsorshipProviderFallback<T>(env: Bindings,
	operation: (provider: SponsorshipProvider) => Promise<T>): Promise<{ provider: SponsorshipProviderName; value: T }> {
	let lastError: unknown;
	for (const name of sponsorshipProviderNames(env)) {
		try {
			return { provider: name, value: await operation(createSponsorshipProvider(name)) };
		} catch (error) {
			lastError = error;
			logWarn("sponsorship_provider_failed_before_signature", { provider: name,
				error: error instanceof Error ? error.name : "unknown" });
		}
	}
	throw lastError instanceof Error ? lastError : new Error("No sponsorship provider is available");
}

export function validateSponsorshipConfig(env: Bindings): string[] {
	const issues: string[] = [];
	const configured = [env.SPONSORSHIP_PROVIDER, env.SPONSORSHIP_FALLBACK_PROVIDER].filter(Boolean);
	if (configured.some((value) => value !== "parmelia" && value !== "erc7677" && value !== "self-funded")) {
		issues.push("SPONSORSHIP_PROVIDER_INVALID");
	}
	let providers: SponsorshipProviderName[];
	try { providers = sponsorshipProviderNames(env); }
	catch { return [...new Set([...issues, "SPONSORSHIP_PROVIDER_INVALID"])]; }
	for (const name of providers) {
		try {
			if (name === "parmelia") configuredParmeliaPaymaster(env);
			if (name === "erc7677") {
				serviceUrl(env);
				serviceContext(env);
				boundedTimeout(env);
				if (!getNetworkConfig(env.CHAIN_KEY).isTestnet &&
					(!env.PAYMASTER_SERVICE_EXPECTED_PAYMASTER || !isAddress(env.PAYMASTER_SERVICE_EXPECTED_PAYMASTER))) {
					issues.push("PAYMASTER_SERVICE_EXPECTED_PAYMASTER_MISSING");
				}
			}
		} catch (error) {
			issues.push(error instanceof SponsorshipError ? `${name.toUpperCase().replace("-", "_")}_CONFIG_INVALID`
				: "SPONSORSHIP_CONFIG_INVALID");
		}
	}
	return [...new Set(issues)];
}

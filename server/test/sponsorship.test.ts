import { afterEach, describe, expect, it, vi } from "vitest";
import { type Address, type Hex } from "viem";
import type { Bindings } from "../src/env";
import {
	createSponsorshipProvider,
	sponsorshipPaymasterAddress,
	sponsorshipProviderNames,
	validateSponsorshipConfig,
	withSponsorshipGasLimits,
	withSponsorshipProviderFallback,
} from "../src/services/sponsorship";
import type { PackedUserOp } from "../src/services/userOp";

const ENTRY_POINT = "0x433709009B8330FDa32311DF1C2AFA402eD8D009" as Address;
const PARMELIA_PAYMASTER = "0x00000000000000000000000000000000000000a1" as Address;
const EXTERNAL_PAYMASTER = "0x00000000000000000000000000000000000000b2" as Address;

const userOp: PackedUserOp = {
	sender: "0x1111111111111111111111111111111111111111",
	nonce: 1n,
	initCode: "0x",
	callData: "0x12345678",
	accountGasLimits: ("0x" + "00".repeat(32)) as Hex,
	preVerificationGas: 100_000n,
	gasFees: ("0x" + "00".repeat(32)) as Hex,
	paymasterAndData: "0x",
	signature: "0xdeadbeef",
};

function environment(extra: Partial<Bindings> = {}): Bindings {
	return {
		CHAIN_KEY: "arbitrum-sepolia",
		PRIVATE_KEY: `0x${"11".repeat(32)}`,
		PAYMASTER_SIGNER_PRIVATE_KEY: `0x${"22".repeat(32)}`,
		...extra,
	} as Bindings;
}

function input(env: Bindings, operation = userOp) {
	return { env, chainId: 421_614, entryPoint: ENTRY_POINT, userOp: operation };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("sponsorship providers", () => {
	it("uses the runtime Parmelia paymaster address instead of coupling to the network manifest", async () => {
		const env = environment({ SPONSORSHIP_PAYMASTER_ADDRESS: PARMELIA_PAYMASTER });
		const prepared = await createSponsorshipProvider("parmelia").prepare(input(env));

		expect(prepared.isFinal).toBe(false);
		expect(prepared.paymasterAndData.slice(0, 42).toLowerCase())
			.toBe(PARMELIA_PAYMASTER.toLowerCase());
		expect(sponsorshipPaymasterAddress(prepared.paymasterAndData)?.toLowerCase())
			.toBe(PARMELIA_PAYMASTER.toLowerCase());
	});

	it("implements the ERC-7677 split-field handshake without disclosing a user signature", async () => {
		const methods: string[] = [];
		vi.stubGlobal("fetch", vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as {
				id: string;
				method: string;
				params: Array<Record<string, unknown>>;
			};
			methods.push(body.method);
			expect(body.params[0]?.signature).toBeUndefined();
			return new Response(JSON.stringify({
				jsonrpc: "2.0",
				id: body.id,
				result: {
					paymaster: EXTERNAL_PAYMASTER,
					paymasterData: body.method === "pm_getPaymasterStubData" ? "0xdead" : "0xcafe",
					...(body.method === "pm_getPaymasterStubData" ? {
						paymasterVerificationGasLimit: "0x186a0",
						paymasterPostOpGasLimit: "0xc350",
					} : {}),
					isFinal: false,
				},
			}), { headers: { "Content-Type": "application/json" } });
		}));
		const env = environment({
			PAYMASTER_SERVICE_URL: "https://paymaster.example/rpc",
			PAYMASTER_SERVICE_EXPECTED_PAYMASTER: EXTERNAL_PAYMASTER,
		});
		const provider = createSponsorshipProvider("erc7677");
		const prepared = await provider.prepare(input(env));
		const final = await provider.finalize(input(env, {
			...userOp,
			paymasterAndData: prepared.paymasterAndData,
		}), prepared);

		expect(methods).toEqual(["pm_getPaymasterStubData", "pm_getPaymasterData"]);
		expect(prepared.paymasterAndData.slice(0, 42).toLowerCase())
			.toBe(EXTERNAL_PAYMASTER.toLowerCase());
		expect(final.endsWith("cafe")).toBe(true);
	});

	it("rewrites packed paymaster gas limits without changing contract or data", async () => {
		const provider = createSponsorshipProvider("parmelia");
		const prepared = await provider.prepare(input(environment({
			SPONSORSHIP_PAYMASTER_ADDRESS: PARMELIA_PAYMASTER,
		})));
		const rewritten = withSponsorshipGasLimits(prepared.paymasterAndData, 123_456n, 78_901n);

		expect(sponsorshipPaymasterAddress(rewritten)?.toLowerCase()).toBe(PARMELIA_PAYMASTER.toLowerCase());
		expect(BigInt(`0x${rewritten.slice(42, 74)}`)).toBe(123_456n);
		expect(BigInt(`0x${rewritten.slice(74, 106)}`)).toBe(78_901n);
		expect(rewritten.slice(106)).toBe(prepared.paymasterAndData.slice(106));
	});

	it("rejects a paymaster contract change between stub and final data", async () => {
		let call = 0;
		vi.stubGlobal("fetch", vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { id: string };
			call += 1;
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {
				paymaster: call === 1 ? EXTERNAL_PAYMASTER : PARMELIA_PAYMASTER,
				paymasterData: "0xdead",
			} }));
		}));
		const env = environment({ PAYMASTER_SERVICE_URL: "https://paymaster.example/rpc" });
		const provider = createSponsorshipProvider("erc7677");
		const prepared = await provider.prepare(input(env));

		await expect(provider.finalize(input(env, { ...userOp,
			paymasterAndData: prepared.paymasterAndData }), prepared))
			.rejects.toThrow("changed contract");
	});

	it("rejects an ERC-7677 response from a contract other than the pinned paymaster", async () => {
		vi.stubGlobal("fetch", vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { id: string };
			return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: {
				paymaster: EXTERNAL_PAYMASTER,
				paymasterData: "0xdead",
			} }));
		}));
		const env = environment({
			PAYMASTER_SERVICE_URL: "https://paymaster.example/rpc",
			PAYMASTER_SERVICE_EXPECTED_PAYMASTER: PARMELIA_PAYMASTER,
		});

		await expect(createSponsorshipProvider("erc7677").prepare(input(env)))
			.rejects.toThrow("unexpected contract");
	});

	it("falls back only before signing and rebuilds through the selected provider callback", async () => {
		const env = environment({
			SPONSORSHIP_PROVIDER: "erc7677",
			SPONSORSHIP_FALLBACK_PROVIDER: "self-funded",
		});
		const visited: string[] = [];
		const result = await withSponsorshipProviderFallback(env, async (provider) => {
			visited.push(provider.name);
			if (provider.name === "erc7677") throw new Error("primary unavailable");
			return provider.prepare(input(env));
		});

		expect(visited).toEqual(["erc7677", "self-funded"]);
		expect(result.provider).toBe("self-funded");
		expect(result.value.paymasterAndData).toBe("0x");
		expect(sponsorshipPaymasterAddress(result.value.paymasterAndData)).toBeNull();
	});

	it("fails mainnet ERC-7677 configuration closed unless the returned contract is pinned", () => {
		const env = environment({
			CHAIN_KEY: "arbitrum-one",
			SPONSORSHIP_PROVIDER: "erc7677",
			PAYMASTER_SERVICE_URL: "https://paymaster.example/rpc",
		});

		expect(sponsorshipProviderNames(env)).toEqual(["erc7677"]);
		expect(validateSponsorshipConfig(env)).toContain("PAYMASTER_SERVICE_EXPECTED_PAYMASTER_MISSING");
	});

	it("does not silently reinterpret an unknown provider as Parmelia", () => {
		const env = environment({ SPONSORSHIP_PROVIDER: "typo-provider" });
		expect(() => sponsorshipProviderNames(env)).toThrow("Unsupported sponsorship provider");
		expect(validateSponsorshipConfig(env)).toContain("SPONSORSHIP_PROVIDER_INVALID");
	});
});

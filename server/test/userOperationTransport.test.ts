import { concat, pad, toHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../src/middlewares/auth";
import {
	packedUserOperationToRpc,
	selectUserOperationTransport,
	__test,
} from "../src/services/userOperationTransport";
import type { PackedUserOp } from "../src/services/userOp";

function packed(value: bigint, next: bigint): Hex {
	return concat([
		pad(toHex(value), { size: 16 }),
		pad(toHex(next), { size: 16 }),
	]);
}

describe("UserOperation transport", () => {
	it("converts EntryPoint v0.9 packed fields to ERC-7769 RPC fields", () => {
		const paymaster =
			"0x1111111111111111111111111111111111111111" as const;
		const userOp: PackedUserOp = {
			sender: "0x2222222222222222222222222222222222222222",
			nonce: 9n,
			initCode: "0x",
			callData: "0x1234",
			accountGasLimits: packed(500_000n, 300_000n),
			preVerificationGas: 100_000n,
			gasFees: packed(1_000_000n, 2_000_000n),
			paymasterAndData: concat([
				paymaster,
				pad(toHex(100_000n), { size: 16 }),
				pad(toHex(50_000n), { size: 16 }),
				"0xaabb",
			]),
			signature: "0xdeadbeef",
		};

		expect(packedUserOperationToRpc(userOp)).toEqual({
			sender: userOp.sender,
			nonce: "0x9",
			callData: "0x1234",
			callGasLimit: toHex(300_000n),
			verificationGasLimit: toHex(500_000n),
			preVerificationGas: toHex(100_000n),
			maxFeePerGas: toHex(2_000_000n),
			maxPriorityFeePerGas: toHex(1_000_000n),
			paymaster,
			paymasterVerificationGasLimit: toHex(100_000n),
			paymasterPostOpGasLimit: toHex(50_000n),
			paymasterData: "0xaabb",
			signature: "0xdeadbeef",
		});
	});

	it("uses a deterministic rollout cohort and never selects bundler at 0%", () => {
		const base = {
			RELAYER_MODE: "bundler",
			BUNDLER_ROLLOUT_PERCENT: "0",
		} as unknown as Bindings;
		expect(selectUserOperationTransport(base, "user-op-a")).toBe("self");
		expect(
			selectUserOperationTransport(
				{
					...base,
					BUNDLER_ROLLOUT_PERCENT: "100",
				} as Bindings,
				"user-op-a",
			),
		).toBe("bundler");
		expect(__test.fnv1aPercent("same")).toBe(
			__test.fnv1aPercent("same"),
		);
	});

	it("uses a stable opaque capability key without leaking the URL", async () => {
		const url = "https://arb-mainnet.g.alchemy.com/v2/super-secret-key";
		const key = await __test.opaqueBundlerEndpointKey(url, 1);

		expect(key).toMatch(/^bundler:1:[0-9a-f]{64}$/u);
		expect(key).not.toContain("alchemy");
		expect(key).not.toContain("super-secret-key");
		expect(await __test.opaqueBundlerEndpointKey(url, 1)).toBe(key);
	});
});

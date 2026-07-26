import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../src/middlewares/auth";
import {
	ARBITRUM_NODE_INTERFACE,
	classifyArbitrumConsistency,
	getArbitrumBlockEvidence,
} from "../src/services/arbitrumFinality";

const hash = `0x${"ab".repeat(32)}` as `0x${string}`;

describe("Arbitrum NodeInterface finality evidence", () => {
	it("keeps batch inclusion distinct from rollup assertion finality", () => {
		expect(classifyArbitrumConsistency(0n, 12n)).toBe("sequenced");
		expect(classifyArbitrumConsistency(1n, 12n)).toBe("batch_posted");
		expect(classifyArbitrumConsistency(12n, 12n)).toBe("l1_confirmed");
	});

	it("reads confirmations first and only resolves a batch after L1 inclusion", async () => {
		const client = {
			readContract: vi
				.fn()
				.mockResolvedValueOnce(15n)
				.mockResolvedValueOnce(44n),
		};
		await expect(
			getArbitrumBlockEvidence(
				{ ARBITRUM_L1_CONFIRMATIONS_REQUIRED: "12" } as Bindings,
				client,
				{ blockNumber: 100n, blockHash: hash },
			),
		).resolves.toEqual({
			consistencyLevel: "l1_confirmed",
			l1Confirmations: 15n,
			l1BatchNumber: 44n,
			source: "node_interface",
			rpcCalls: 2,
		});
		expect(client.readContract).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				address: ARBITRUM_NODE_INTERFACE,
				functionName: "getL1Confirmations",
			}),
		);
	});

	it("degrades explicitly when a provider does not implement NodeInterface", async () => {
		const client = {
			readContract: vi.fn().mockRejectedValue(new Error("unsupported")),
		};
		await expect(
			getArbitrumBlockEvidence({} as Bindings, client, {
				blockNumber: 100n,
				blockHash: hash,
			}),
		).resolves.toEqual({
			consistencyLevel: "sequenced",
			l1Confirmations: null,
			l1BatchNumber: null,
			source: "unavailable",
			rpcCalls: 1,
		});
	});
});

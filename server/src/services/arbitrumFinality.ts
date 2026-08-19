import { parseAbi, type Address, type Hex } from "viem";
import type { Bindings } from "../middlewares/auth";
import type { ChainConsistencyLevel } from "./chainJournal";
import { logWarn } from "./logger";

// Official Nitro NodeInterface virtual contract. No bytecode exists at this
// address; Arbitrum nodes intercept eth_call and execute the documented ABI.
export const ARBITRUM_NODE_INTERFACE =
	"0x00000000000000000000000000000000000000C8" as Address;

const NODE_INTERFACE_ABI = parseAbi([
	"function findBatchContainingBlock(uint64 blockNum) view returns (uint64 batch)",
	"function getL1Confirmations(bytes32 blockHash) view returns (uint64 confirmations)",
]);

type NodeInterfaceReader = {
	readContract(parameters: {
		address: Address;
		abi: typeof NODE_INTERFACE_ABI;
		functionName: string;
		args: readonly unknown[];
	}): Promise<unknown>;
};

export type ArbitrumBlockEvidence = {
	consistencyLevel: ChainConsistencyLevel;
	l1Confirmations: bigint | null;
	l1BatchNumber: bigint | null;
	source: "node_interface" | "unavailable";
	rpcCalls: number;
};

function requiredL1Confirmations(env: Bindings): bigint {
	const parsed = Number(env.ARBITRUM_L1_CONFIRMATIONS_REQUIRED);
	return BigInt(
		Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 256
			? parsed
			: 12,
	);
}

export function classifyArbitrumConsistency(
	confirmations: bigint,
	required: bigint,
): ChainConsistencyLevel {
	if (confirmations <= 0n) return "sequenced";
	if (confirmations < required) return "batch_posted";
	return "l1_confirmed";
}

/**
 * Read block-specific L1 batch evidence. `getL1Confirmations` explicitly does
 * not mean that the Rollup assertion is confirmed, so this function never
 * returns `assertion_confirmed` or `finalized`.
 */
export async function getArbitrumBlockEvidence(
	env: Bindings,
	client: unknown,
	input: { blockNumber: bigint; blockHash: Hex },
): Promise<ArbitrumBlockEvidence> {
	try {
		const reader = client as NodeInterfaceReader;
		const confirmationsResult = await reader.readContract({
			address: ARBITRUM_NODE_INTERFACE,
			abi: NODE_INTERFACE_ABI,
			functionName: "getL1Confirmations",
			args: [input.blockHash],
		});
		if (typeof confirmationsResult !== "bigint") {
			throw new Error("NodeInterface returned invalid L1 confirmations");
		}
		const confirmations = confirmationsResult;
		if (confirmations === 0n) {
			return {
				consistencyLevel: "sequenced",
				l1Confirmations: 0n,
				l1BatchNumber: null,
				source: "node_interface",
				rpcCalls: 1,
			};
		}
		const batchResult = await reader.readContract({
			address: ARBITRUM_NODE_INTERFACE,
			abi: NODE_INTERFACE_ABI,
			functionName: "findBatchContainingBlock",
			args: [input.blockNumber],
		});
		if (typeof batchResult !== "bigint") {
			throw new Error("NodeInterface returned invalid batch number");
		}
		const batch = batchResult;
		return {
			consistencyLevel: classifyArbitrumConsistency(
				confirmations,
				requiredL1Confirmations(env),
			),
			l1Confirmations: confirmations,
			l1BatchNumber: batch,
			source: "node_interface",
			rpcCalls: 2,
		};
	} catch (error) {
		logWarn("arbitrum_finality_evidence_unavailable", {
			errorName: error instanceof Error ? error.name : "unknown",
			blockNumber: input.blockNumber.toString(),
		});
		return {
			consistencyLevel: "sequenced",
			l1Confirmations: null,
			l1BatchNumber: null,
			source: "unavailable",
			rpcCalls: 1,
		};
	}
}

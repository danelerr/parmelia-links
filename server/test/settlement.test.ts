import { describe, expect, it } from "vitest";
import {
	encodeAbiParameters,
	encodeEventTopics,
	parseAbiItem,
	type Hex,
	type Log,
} from "viem";
import { __test, getUserOpResult } from "../src/services/settlement";

// The exact event the EntryPoint emits per op inside a handleOps bundle.
const USER_OPERATION_EVENT = parseAbiItem(
	"event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
);

const ENTRY_POINT = "0x433709009B8330FDa32311DF1C2AFA402eD8D009" as const;
const OP_HASH = ("0x" + "ab".repeat(32)) as Hex;
const OTHER_HASH = ("0x" + "cd".repeat(32)) as Hex;

function opEventLog(userOpHash: Hex, success: boolean, actualGasCost = 1234n): Log {
	const topics = encodeEventTopics({
		abi: [USER_OPERATION_EVENT],
		eventName: "UserOperationEvent",
		args: {
			userOpHash,
			sender: "0x000000000000000000000000000000000000beef",
			paymaster: "0x000000000000000000000000000000000000cafe",
		},
	});
	const data = encodeAbiParameters(
		[{ type: "uint256" }, { type: "bool" }, { type: "uint256" }, { type: "uint256" }],
		[7n, success, actualGasCost, 999n],
	);
	return { address: ENTRY_POINT, topics, data } as unknown as Log;
}

/** An unrelated log (e.g. an ERC-20 Transfer) that must be ignored. */
function noiseLog(): Log {
	return {
		address: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d",
		topics: [("0x" + "11".repeat(32)) as Hex, ("0x" + "22".repeat(32)) as Hex],
		data: ("0x" + "00".repeat(32)) as Hex,
	} as unknown as Log;
}

// receipt.status only reflects the handleOps BUNDLE; the op's own outcome lives
// in this event. These tests pin the parser that closes the false-success hole.
describe("getUserOpResult", () => {
	it("reports success for the matching op", () => {
		const result = getUserOpResult([noiseLog(), opEventLog(OP_HASH, true, 5555n)], OP_HASH);
		expect(result).toEqual({ success: true, actualGasCost: 5555n });
	});

	it("reports failure when the op's inner execution reverted (bundle still mined)", () => {
		const result = getUserOpResult([opEventLog(OP_HASH, false)], OP_HASH);
		expect(result).toEqual({ success: false, actualGasCost: 1234n });
	});

	it("returns null when the receipt carries no event for this hash", () => {
		expect(getUserOpResult([noiseLog()], OP_HASH)).toBeNull();
		expect(getUserOpResult([], OP_HASH)).toBeNull();
	});

	it("does not confuse another op's event in the same bundle", () => {
		const logs = [opEventLog(OTHER_HASH, true), opEventLog(OP_HASH, false)];
		expect(getUserOpResult(logs, OP_HASH)).toEqual({ success: false, actualGasCost: 1234n });
	});

	it("matches the hash case-insensitively", () => {
		const upper = OP_HASH.toUpperCase().replace("0X", "0x") as Hex;
		expect(getUserOpResult([opEventLog(OP_HASH, true)], upper)?.success).toBe(true);
	});
});

describe("confirmed balance refresh targets", () => {
	it("refreshes both sides of an in-app payment in one settlement", () => {
		expect(
			__test.confirmedBalanceRefreshTargets(
				{
					uid: "sender",
					senderAddress: "0x1111111111111111111111111111111111111111",
					wallet: "0x2222222222222222222222222222222222222222",
					currency: "USDC",
				},
				"recipient",
			),
		).toEqual([
			{
				uid: "sender",
				accountAddress: "0x1111111111111111111111111111111111111111",
			},
			{
				uid: "recipient",
				accountAddress: "0x2222222222222222222222222222222222222222",
			},
		]);
	});

	it("does not invent a recipient refresh for self-directed account actions", () => {
		expect(
			__test.confirmedBalanceRefreshTargets(
				{
					uid: "sender",
					senderAddress: "0x1111111111111111111111111111111111111111",
					wallet: "0x2222222222222222222222222222222222222222",
					currency: "EARN_WITHDRAW",
				},
				"recipient",
			),
		).toEqual([
			{
				uid: "sender",
				accountAddress: "0x1111111111111111111111111111111111111111",
			},
		]);
	});
});

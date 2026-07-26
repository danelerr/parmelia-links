import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAlchemySignature, __test } from "../src/services/alchemyWebhook";
import { __test as customTest } from "../src/services/alchemyCustomWebhook";

describe("Alchemy Address Activity webhook", () => {
	it("verifies the HMAC over the exact raw request body", async () => {
		const key = "whsec-test-signing-key";
		const raw = '{"type":"ADDRESS_ACTIVITY","event":{"activity":[]}}';
		const signature = createHmac("sha256", key).update(raw).digest("hex");

		await expect(verifyAlchemySignature(raw, signature, key)).resolves.toBe(true);
		await expect(
			verifyAlchemySignature(`${raw}\n`, signature, key),
		).resolves.toBe(false);
		await expect(
			verifyAlchemySignature(raw, "not-a-hex-signature", key),
		).resolves.toBe(false);
	});

	it("rejects envelopes outside the strict Address Activity schema", () => {
		expect(__test.parseEnvelope("{}")).toBeNull();
		expect(
			__test.parseEnvelope(JSON.stringify({
				webhookId: "wh_1",
				id: "evt_1",
				type: "ADDRESS_ACTIVITY",
				event: { network: "ARB_SEPOLIA", activity: new Array(501).fill({}) },
			})),
		).toBeNull();
	});

	it("uses the activity block for native ETH and token wakeups", () => {
		const wallet = "0x1111111111111111111111111111111111111111";
		const counterparty =
			"0x2222222222222222222222222222222222222222";
		const token = "0x3333333333333333333333333333333333333333";
		const activities = [
			{
				blockNum: "0x64",
				fromAddress: counterparty,
				toAddress: wallet,
			},
			{
				blockNum: "0x65",
				fromAddress: wallet,
				toAddress: counterparty,
				log: { address: token },
			},
		];

		expect(__test.normalizeBalanceSignals(activities)).toEqual([
			{ walletAddress: counterparty, targetBlock: 101n },
			{ walletAddress: wallet, targetBlock: 101n },
		]);
		expect(
			__test.normalizeSignals(activities, new Set([token])),
		).toEqual([
			{
				walletAddress: wallet,
				token,
				direction: "from",
				targetBlock: 101n,
			},
			{
				walletAddress: counterparty,
				token,
				direction: "to",
				targetBlock: 101n,
			},
		]);
	});
});

describe("Alchemy Custom Webhook wakeup", () => {
	it("accepts only the bounded GRAPHQL envelope used as a wakeup signal", () => {
		expect(
			customTest.parseCustomEnvelope(
				JSON.stringify({
					webhookId: "wh_custom",
					id: "whevt_1",
					type: "GRAPHQL",
					event: {
						sequenceNumber: "1000000000001",
						data: { block: { logs: [] } },
					},
				}),
			),
		).not.toBeNull();
		expect(
			customTest.parseCustomEnvelope(
				JSON.stringify({
					webhookId: "wh_custom",
					id: "whevt_1",
					type: "ADDRESS_ACTIVITY",
					event: { sequenceNumber: "1", data: {} },
				}),
			),
		).toBeNull();
	});

	it("routes recognized custom logs only to their owning partitions", () => {
		const account = "0x1111111111111111111111111111111111111111";
		const recovery = customTest.inspectCustomSignalData({
			block: {
				logs: [{
					account: { address: account },
					topics: [
						customTest.RECOVERY_PROPOSED_TOPIC,
						`0x${"0".repeat(24)}${account.slice(2)}`,
					],
				}],
			},
		});
		expect(recovery).toMatchObject({
			router: false,
			recovery: true,
			recognizedTopic: true,
			truncated: false,
		});
		expect(recovery.addresses).toEqual([account]);

		const router = customTest.inspectCustomSignalData({
			logs: [{ topics: [customTest.INVOICE_PAID_TOPIC] }],
		});
		expect(router).toMatchObject({
			router: true,
			recovery: false,
			recognizedTopic: true,
		});
	});
});

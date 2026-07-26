import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyAlchemySignature, __test } from "../src/services/alchemyWebhook";

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
});

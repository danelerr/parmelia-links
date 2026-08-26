import { describe, expect, it } from "vitest";
import { parsePaymentJobMessage } from "../../shared/paymentContracts";

describe("versioned payment contracts", () => {
	it("normalizes N-1 Queue messages to current version", () => {
		const parsed = parsePaymentJobMessage({ messageVersion: 1, job: "webhook_delivery",
			jobId: "job-1", resourceId: "event-1", createdAt: "2026-08-24T12:00:00.000Z" });
		expect(parsed).toEqual({ messageVersion: 2, job: "webhook_delivery", jobId: "job-1",
			dedupeKey: "job-1", resourceId: "event-1", partition: "legacy", attempt: 0,
			createdAt: "2026-08-24T12:00:00.000Z" });
	});

	it("rejects unknown future versions", () => {
		expect(parsePaymentJobMessage({ messageVersion: 3, job: "webhook_delivery", jobId: "x",
			resourceId: "y", createdAt: new Date().toISOString() })).toBeNull();
	});

	it("rejects job names without an implemented Payments runner", () => {
		expect(parsePaymentJobMessage({ messageVersion: 2, job: "webhook_key_rotation",
			jobId: "job-rotation", dedupeKey: "rotation:1", resourceId: "rotation-1",
			partition: "default", attempt: 0, createdAt: new Date().toISOString() })).toBeNull();
	});
});

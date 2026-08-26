import { describe, expect, it } from "vitest";
import { classifyPaymentsDataCutover } from "../src/services/dataCutover";

const checksum = "11".repeat(32);
const loaded = {
	legacy_copy_version: 1,
	legacy_copy_completed_at: "2026-08-25T00:00:00.000Z",
	legacy_source_checksum: checksum,
	legacy_target_checksum: checksum,
};

describe("Payments data cutover gate", () => {
	it("keeps the declared pre-import state pending", () => {
		expect(classifyPaymentsDataCutover("pending", null)).toMatchObject({
			ready: false, status: "pending", configValid: true,
			reason: "configured_checksum_pending",
		});
	});

	it("fails closed for missing or malformed configuration", () => {
		expect(classifyPaymentsDataCutover(undefined, null)).toMatchObject({
			ready: false, status: "invalid", configValid: false,
		});
		expect(classifyPaymentsDataCutover("not-a-checksum", loaded)).toMatchObject({
			ready: false, status: "invalid", configValid: false,
		});
	});

	it("requires a completed control row with matching SHA-256 checksums", () => {
		expect(classifyPaymentsDataCutover(checksum, {
			...loaded, legacy_copy_version: 0,
		})).toMatchObject({ ready: false, status: "pending", reason: "migration_incomplete" });
		expect(classifyPaymentsDataCutover(checksum, {
			...loaded, legacy_target_checksum: "22".repeat(32),
		})).toMatchObject({ ready: false, status: "invalid", reason: "migration_checksum_mismatch" });
		expect(classifyPaymentsDataCutover(checksum, loaded)).toEqual({
			ready: true,
			status: "verified",
			configValid: true,
			databaseValid: true,
			reason: "verified",
		});
	});
});

import { describe, expect, it } from "vitest";
import { P256_N, normalizeLowS, serializeBigInts } from "../src/services/userOp";

function toHex32(value: bigint): string {
	return "0x" + value.toString(16).padStart(64, "0");
}

describe("normalizeLowS", () => {
	it("leaves low-s values untouched (padded to 32 bytes)", () => {
		expect(normalizeLowS("0x01")).toBe(toHex32(1n));
		expect(normalizeLowS(toHex32(P256_N / 2n))).toBe(toHex32(P256_N / 2n));
	});

	it("flips high-s values to n - s", () => {
		const highS = P256_N - 2n; // well above n/2
		expect(normalizeLowS(toHex32(highS))).toBe(toHex32(2n));
	});

	it("always returns a 0x-prefixed 32-byte hex string", () => {
		const out = normalizeLowS("0x01");
		expect(out.startsWith("0x")).toBe(true);
		expect(out.length).toBe(66); // 0x + 64 hex chars
	});
});

describe("serializeBigInts", () => {
	it("converts bigints to hex strings", () => {
		expect(serializeBigInts(255n)).toBe("0xff");
		expect(serializeBigInts(0n)).toBe("0x0");
	});

	it("recurses into arrays and objects", () => {
		expect(serializeBigInts([1n, 2n])).toEqual(["0x1", "0x2"]);
		expect(serializeBigInts({ nonce: 16n, nested: { gas: 10n } })).toEqual({
			nonce: "0x10",
			nested: { gas: "0xa" },
		});
	});

	it("passes through non-bigint primitives", () => {
		expect(serializeBigInts("hi")).toBe("hi");
		expect(serializeBigInts(42)).toBe(42);
		expect(serializeBigInts(null)).toBeNull();
	});
});

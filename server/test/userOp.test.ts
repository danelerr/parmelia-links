import { describe, expect, it } from "vitest";
import { P256_N, matchOnchainSigner, normalizeLowS, serializeBigInts } from "../src/services/userOp";

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

// matchOnchainSigner: resolves the signer bytes REGISTERED on the account
// instead of rebuilding them from the network's current verifier. Pinned by
// the jul-2026 incident: a verifier redeploy changed the global address and
// every pre-existing account stopped validating signatures.
describe("matchOnchainSigner", () => {
	type Hex = `0x${string}`;
	const OLD_VERIFIER = "0xb7fa10dee75042d6973676a7d7882e4621b806d6";
	const NEW_VERIFIER = "0x14d5d46fc6ed1154f3719f87ae72c3020d4fb886";
	const QX = ("0x" + "11".repeat(32)) as Hex;
	const QY = ("0x" + "22".repeat(32)) as Hex;
	const OTHER_QX = ("0x" + "33".repeat(32)) as Hex;

	function signer(verifier: string, qx: Hex, qy: Hex): Hex {
		return (verifier + qx.slice(2) + qy.slice(2)) as Hex;
	}

	it("finds the signer registered with a PREVIOUS verifier generation (the incident)", () => {
		const onchain = [signer(OLD_VERIFIER, QX, QY)];
		expect(matchOnchainSigner(onchain, QX, QY)).toBe(onchain[0]);
	});

	it("picks the right signer among multiple keys/verifier generations", () => {
		const oldGen = signer(OLD_VERIFIER, QX, QY);
		const newGen = signer(NEW_VERIFIER, OTHER_QX, QY);
		expect(matchOnchainSigner([newGen, oldGen], QX, QY)).toBe(oldGen);
		expect(matchOnchainSigner([newGen, oldGen], OTHER_QX, QY)).toBe(newGen);
	});

	it("matches case-insensitively (checksummed on-chain bytes vs lowercase input)", () => {
		const mixed = ("0x" + signer(OLD_VERIFIER, QX, QY).slice(2).toUpperCase()) as Hex;
		expect(matchOnchainSigner([mixed], QX, QY)).toBe(mixed);
	});

	it("returns null when no registered signer matches the key", () => {
		const onchain = [signer(OLD_VERIFIER, OTHER_QX, QY)];
		expect(matchOnchainSigner(onchain, QX, QY)).toBeNull();
	});

	it("returns null for malformed key coordinates", () => {
		const onchain = [signer(OLD_VERIFIER, QX, QY)];
		expect(matchOnchainSigner(onchain, "0x1234" as Hex, QY)).toBeNull();
	});
});

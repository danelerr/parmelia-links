import { describe, expect, it } from "vitest";
import { hashTypedData, type Hex } from "viem";
import {
	PACKED_USER_OPERATION_EIP712_TYPES,
	P256_N,
	buildUserOperationSigningPayload,
	isCompletePasskeyInventory,
	matchOnchainSigner,
	passkeySignerActivity,
	maximumSelfFundedUserOpCost,
	normalizeLowS,
	serializeBigInts,
	type PackedUserOp,
} from "../src/services/userOp";

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

describe("maximumSelfFundedUserOpCost", () => {
	it("bounds the native prefund before selecting the self-funded fallback", () => {
		expect(maximumSelfFundedUserOpCost({ verificationGasLimit: 500_000n,
			callGasLimit: 300_000n, preVerificationGas: 100_000n, maxFeePerGas: 2n }))
			.toBe(1_800_000n);
	});
});

describe("buildUserOperationSigningPayload", () => {
	const entryPoint = "0x433709009B8330FDa32311DF1C2AFA402eD8D009";
	const userOp: PackedUserOp = {
		sender: "0x1111111111111111111111111111111111111111",
		nonce: 7n,
		initCode: "0x",
		callData: "0x12345678",
		accountGasLimits: ("0x" + "00".repeat(31) + "01") as Hex,
		preVerificationGas: 100_000n,
		gasFees: ("0x" + "00".repeat(31) + "02") as Hex,
		paymasterAndData: "0xabcdef",
		signature: "0x",
	};

	it("returns the canonical ERC-4337 EIP-712 document and digest", () => {
		const payload = buildUserOperationSigningPayload(userOp, 421_614, entryPoint);
		const independentDigest = hashTypedData({
			domain: {
				name: "ERC4337",
				version: "1",
				chainId: 421_614,
				verifyingContract: entryPoint,
			},
			types: PACKED_USER_OPERATION_EIP712_TYPES,
			primaryType: "PackedUserOperation",
			message: userOp,
		});

		expect(payload.standard).toBe("EIP-712");
		expect(payload.primaryType).toBe("PackedUserOperation");
		expect(payload.domain.verifyingContract).toBe(entryPoint);
		expect(payload.message.nonce).toBe("7");
		expect(payload.digest).toBe(independentDigest);
	});

	it("binds the digest to the call the user is authorizing", () => {
		const original = buildUserOperationSigningPayload(userOp, 421_614, entryPoint);
		const changed = buildUserOperationSigningPayload(
			{ ...userOp, callData: "0x87654321" },
			421_614,
			entryPoint,
		);

		expect(changed.digest).not.toBe(original.digest);
	});

	it("binds the digest to the selected paymaster, so rotation requires a fresh signature", () => {
		const original = buildUserOperationSigningPayload(userOp, 421_614, entryPoint);
		const changed = buildUserOperationSigningPayload(
			{
				...userOp,
				paymasterAndData: "0x00000000000000000000000000000000000000b2abcdef",
			},
			421_614,
			entryPoint,
		);

		expect(changed.digest).not.toBe(original.digest);
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

describe("passkeySignerActivity", () => {
	const verifier = "0xb7fa10dee75042d6973676a7d7882e4621b806d6";
	const activeQx = ("0x" + "11".repeat(32)) as Hex;
	const inactiveQx = ("0x" + "33".repeat(32)) as Hex;
	const qy = ("0x" + "22".repeat(32)) as Hex;
	const signer = (verifier + activeQx.slice(2) + qy.slice(2)) as Hex;

	it("marks each stored credential from its actual on-chain signer match", () => {
		expect(passkeySignerActivity([signer], [
			{ qx: activeQx, qy },
			{ qx: inactiveQx, qy },
		])).toEqual([true, false]);
	});
});

describe("isCompletePasskeyInventory", () => {
	type Hex = `0x${string}`;
	const VERIFIER = "0xb7fa10dee75042d6973676a7d7882e4621b806d6";
	const qx = ("0x" + "11".repeat(32)) as Hex;
	const qy = ("0x" + "22".repeat(32)) as Hex;
	const signer = (VERIFIER + qx.slice(2) + qy.slice(2)) as Hex;
	const passkey = { qx, qy, rpId: "app.parmelia.me" };

	it("accepts only an exact one-to-one signer inventory", () => {
		expect(isCompletePasskeyInventory({ signerCount: 1n, signers: [signer], passkeys: [passkey] }))
			.toBe(true);
	});

	it("fails closed when the signer page is shorter than the on-chain count", () => {
		expect(isCompletePasskeyInventory({ signerCount: 33n, signers: [signer], passkeys: [passkey] }))
			.toBe(false);
	});

	it("fails closed for unscoped or duplicate management records", () => {
		expect(isCompletePasskeyInventory({
			signerCount: 1n,
			signers: [signer],
			passkeys: [{ ...passkey, rpId: null }],
		})).toBe(false);
		expect(isCompletePasskeyInventory({
			signerCount: 2n,
			signers: [signer, signer],
			passkeys: [passkey, passkey],
		})).toBe(false);
	});
});

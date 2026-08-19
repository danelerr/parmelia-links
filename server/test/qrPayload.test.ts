import { describe, expect, it } from "vitest";
import { parseQrPayload } from "../../client/src/lib/qrPayload";

const context = {
	origin: "https://app.parmelia.me",
	appUrl: "https://app.parmelia.me",
};
const wallet = "0x1111111111111111111111111111111111111111";

describe("wallet QR payloads", () => {
	it("accepts plain EVM addresses", () => {
		expect(parseQrPayload(wallet, context)).toEqual({
			kind: "evm-wallet",
			address: wallet,
			chainId: null,
			source: "address",
		});
	});

	it("accepts ERC-681 and CAIP-10 chain-aware accounts", () => {
		expect(parseQrPayload(`ethereum:${wallet}@8453`, context)).toMatchObject({
			kind: "evm-wallet",
			address: wallet,
			chainId: 8453,
			source: "eip681",
		});
		expect(parseQrPayload(`eip155:42161:${wallet}`, context)).toMatchObject({
			kind: "evm-wallet",
			address: wallet,
			chainId: 42161,
			source: "caip10",
		});
	});

	it("extracts only the beneficiary from ERC-20 payment requests", () => {
		const token = "0x2222222222222222222222222222222222222222";
		expect(
			parseQrPayload(
				`ethereum:${token}@42161/transfer?address=${wallet}&uint256=1000000`,
				context,
			),
		).toMatchObject({ address: wallet, chainId: 42161, source: "eip681" });
	});

	it("keeps GatoPago links internal and rejects lookalike hosts", () => {
		expect(parseQrPayload("https://app.parmelia.me/pay?id=abc", context)).toEqual({
			kind: "gatopago",
			target: "/pay?id=abc",
		});
		expect(parseQrPayload("https://parmelia.example/pay?id=abc", context)).toBeNull();
		expect(parseQrPayload("https://evilparmelia.me/pay?id=abc", context)).toBeNull();
		expect(parseQrPayload("//evil.example/pay?id=abc", context)).toBeNull();
	});

	it("does not execute arbitrary contract-call QRs", () => {
		expect(
			parseQrPayload(`ethereum:${wallet}@42161/approve?address=${wallet}&uint256=1`, context),
		).toBeNull();
	});
});

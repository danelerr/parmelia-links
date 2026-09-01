import { describe, expect, it } from "vitest";
import { ledgerNetworkMetadata } from "../src/routes/transactions.routes";

describe("ledger network metadata", () => {
	it("maps legacy rows without a chain id to the configured home chain", () => {
		expect(ledgerNetworkMetadata(null, "arbitrum-sepolia")).toEqual({
			chainId: 421614,
			chainKey: "arbitrum-sepolia",
			networkName: "Arbitrum Sepolia",
		});
	});

	it("preserves a known Avalanche chain", () => {
		expect(ledgerNetworkMetadata(43113, "arbitrum-sepolia")).toEqual({
			chainId: 43113,
			chainKey: "avalanche-fuji",
			networkName: "Avalanche Fuji",
		});
	});

	it("never relabels an explicit unknown chain as Arbitrum", () => {
		expect(ledgerNetworkMetadata(999_999, "arbitrum-sepolia")).toEqual({
			chainId: 999_999,
			networkName: "Chain ID 999999",
		});
	});
});

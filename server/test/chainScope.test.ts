import { describe, expect, it } from "vitest";
import {
	appChainCapabilities,
	bindingsForChain,
	enabledAppChainKeys,
	resolveAppChainKey,
} from "../src/services/chainScope";
import type { Bindings } from "../src/middlewares/auth";

function env(overrides: Partial<Bindings> = {}): Bindings {
	return {
		CHAIN_KEY: "arbitrum-sepolia",
		APP_ENABLED_CHAIN_KEYS: "arbitrum-sepolia,avalanche-fuji",
		RPC_READ_URLS: "https://arb-read.example",
		RPC_WRITE_URLS: "https://arb-write.example",
		APP_CHAIN_RPC_URLS: JSON.stringify({
			"43113": {
				read: "https://fuji-read.example",
				write: "https://fuji-write.example",
				indexer: "https://fuji-indexer.example",
				archive: "https://fuji-archive.example",
				bundler: "https://fuji-bundler.example",
			},
		}),
		...overrides,
	} as Bindings;
}

describe("App chain scope", () => {
	it("deduplicates and rejects unsupported enabled chain keys", () => {
		expect(enabledAppChainKeys(env({
			APP_ENABLED_CHAIN_KEYS: "avalanche-fuji,unknown,avalanche-fuji,arbitrum-sepolia",
		}))).toEqual(["avalanche-fuji", "arbitrum-sepolia"]);
	});

	it("creates immutable request-scoped bindings for Avalanche RPC roles", () => {
		const root = env();
		const scoped = bindingsForChain(root, "avalanche-fuji");

		expect(scoped).not.toBe(root);
		expect(scoped).toMatchObject({
			CHAIN_KEY: "avalanche-fuji",
			RPC_READ_URLS: "https://fuji-read.example",
			RPC_WRITE_URLS: "https://fuji-write.example",
			RPC_INDEXER_URLS: "https://fuji-indexer.example",
			RPC_ARCHIVE_URLS: "https://fuji-archive.example",
			BUNDLER_RPC_URLS: "https://fuji-bundler.example",
		});
		expect(root.CHAIN_KEY).toBe("arbitrum-sepolia");
		expect(root.RPC_READ_URLS).toBe("https://arb-read.example");
	});

	it("merges legacy CCTP RPC entries without letting them override App roles", () => {
		const legacyOnly = bindingsForChain(env({
			APP_CHAIN_RPC_URLS: JSON.stringify({ "84532": "https://base.example" }),
			CCTP_RPC_URLS: JSON.stringify({ "43113": "https://fuji-legacy.example" }),
		}), "avalanche-fuji");
		expect(legacyOnly.RPC_READ_URLS).toBe("https://fuji-legacy.example");

		const appWins = bindingsForChain(env({
			CCTP_RPC_URLS: JSON.stringify({ "43113": "https://fuji-legacy.example" }),
		}), "avalanche-fuji");
		expect(appWins.RPC_READ_URLS).toBe("https://fuji-read.example");
	});

	it("keeps the Fuji wallet rail fail closed until the runtime rollout flag", () => {
		const root = env();
		expect(resolveAppChainKey(root, "avalanche-fuji")).toBe("avalanche-fuji");
		expect(resolveAppChainKey(root, "avalanche-fuji", { requireWalletRail: true })).toBeNull();
		const fuji = appChainCapabilities(root).find((chain) => chain.key === "avalanche-fuji");
		expect(fuji).toMatchObject({
			chainId: 43113,
			nativeTokenSymbol: "AVAX",
			walletRailEnabled: false,
			rpcConfigured: true,
		});
		expect(fuji?.assets.map((asset) => asset.symbol)).toEqual(["AVAX", "USDC"]);
	});

	it("enables the implemented Fuji rail only through its explicit allowlist", () => {
		const root = env({
			APP_WALLET_RAIL_CHAIN_KEYS: "arbitrum-sepolia,avalanche-fuji",
		});
		expect(
			resolveAppChainKey(root, "avalanche-fuji", {
				requireWalletRail: true,
			}),
		).toBe("avalanche-fuji");
		expect(
			appChainCapabilities(root).find(
				(chain) => chain.key === "avalanche-fuji",
			)?.walletRailEnabled,
		).toBe(true);
	});
});

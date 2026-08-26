import type { Address, Eip1193Provider } from "./types";

const CHAIN_PARAMS: Record<number, Record<string, unknown>> = {
	421614: {
		chainId: "0x66eee",
		chainName: "Arbitrum Sepolia",
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
		blockExplorerUrls: ["https://sepolia.arbiscan.io"],
	},
	84532: {
		chainId: "0x14a34",
		chainName: "Base Sepolia",
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: ["https://sepolia.base.org"],
		blockExplorerUrls: ["https://sepolia.basescan.org"],
	},
	43113: {
		chainId: "0xa869",
		chainName: "Avalanche Fuji",
		nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
		rpcUrls: ["https://api.avax-test.network/ext/bc/C/rpc"],
		blockExplorerUrls: ["https://testnet.snowtrace.io"],
	},
	42161: {
		chainId: "0xa4b1",
		chainName: "Arbitrum One",
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: ["https://arb1.arbitrum.io/rpc"],
		blockExplorerUrls: ["https://arbiscan.io"],
	},
	8453: {
		chainId: "0x2105",
		chainName: "Base",
		nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
		rpcUrls: ["https://mainnet.base.org"],
		blockExplorerUrls: ["https://basescan.org"],
	},
	43114: {
		chainId: "0xa86a",
		chainName: "Avalanche",
		nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
		rpcUrls: ["https://api.avax.network/ext/bc/C/rpc"],
		blockExplorerUrls: ["https://snowtrace.io"],
	},
};

export function injectedProvider(): Eip1193Provider | null {
	return (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;
}

export async function connectProvider(): Promise<{
	provider: Eip1193Provider;
	account: Address;
	chainId: number;
}> {
	const provider = injectedProvider();
	if (!provider) throw new Error("INJECTED_WALLET_UNAVAILABLE");
	const accounts = (await provider.request({
		method: "eth_requestAccounts",
	})) as string[];
	const account = accounts[0];
	if (!account || !/^0x[0-9a-fA-F]{40}$/u.test(account)) throw new Error("WALLET_ACCOUNT_UNAVAILABLE");
	const chainHex = (await provider.request({ method: "eth_chainId" })) as string;
	return { provider, account: account as Address, chainId: Number.parseInt(chainHex, 16) };
}

export async function ensureProviderChain(provider: Eip1193Provider, chainId: number): Promise<void> {
	const chainHex = `0x${chainId.toString(16)}`;
	const current = (await provider.request({ method: "eth_chainId" })) as string;
	if (Number.parseInt(current, 16) === chainId) return;
	try {
		await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainHex }] });
	} catch (error) {
		if ((error as { code?: number }).code !== 4902 || !CHAIN_PARAMS[chainId]) throw error;
		await provider.request({ method: "wallet_addEthereumChain", params: [CHAIN_PARAMS[chainId]] });
	}
}

export function shortAddress(address: string): string {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function explorerTransactionUrl(chainId: number, hash: string): string | null {
	const bases: Record<number, string> = {
		421614: "https://sepolia.arbiscan.io/tx/",
		84532: "https://sepolia.basescan.org/tx/",
		43113: "https://testnet.snowtrace.io/tx/",
		42161: "https://arbiscan.io/tx/",
		8453: "https://basescan.org/tx/",
		43114: "https://snowtrace.io/tx/",
	};
	return bases[chainId] ? `${bases[chainId]}${hash}` : null;
}

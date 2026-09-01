import { useCallback, useRef, useState } from "react";
import useSWR from "swr";
import type { User } from "../lib/firebase";
import { apiFetch, SERVER_URL } from "../lib/api";

type ChainPortfolioAsset = {
	symbol: string;
	name: string;
	decimals: number;
	isNative: boolean;
	value: string | null;
	raw: string | null;
	status: "fresh" | "stale" | "unavailable";
	observedAt: string | null;
	blockNumber: string | null;
	blockHash: string | null;
};

export type ChainPortfolioItem = {
	key: string;
	chainId: number;
	name: string;
	nativeTokenSymbol: string;
	isTestnet: boolean;
	walletRailEnabled: boolean;
	explorerBaseUrl: string;
	faucetUrl: string | null;
	rpcConfigured: boolean;
	swapEnabled: boolean;
	account: null | {
		walletAddress: string;
		status: "deploying" | "active" | "failed" | "disabled";
		securityStatus: "current" | "needs_sync" | "syncing" | "failed";
		securityVersionApplied: number;
		securityVersionDesired: number;
	};
	balance: { assets: ChainPortfolioAsset[] };
};

export type ChainPortfolio = { chains: ChainPortfolioItem[] };

export function useChainPortfolio(user: User | null, previewData?: ChainPortfolio) {
	const swr = useSWR<ChainPortfolio>(
		user && !previewData ? `${SERVER_URL}/account/chains` : null,
		() => apiFetch<ChainPortfolio>("/account/chains", { user }),
		{
			revalidateOnFocus: false,
			revalidateOnReconnect: true,
			dedupingInterval: 10_000,
		},
	);
	const [refreshingChainKeys, setRefreshingChainKeys] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const refreshRefs = useRef(new Map<string, Promise<void>>());
	const mutate = swr.mutate;
	const refreshChainBalance = useCallback((chainKey: string): Promise<void> => {
		if (!user || previewData) return Promise.resolve();
		const running = refreshRefs.current.get(chainKey);
		if (running) return running;
		setRefreshingChainKeys((current) => new Set(current).add(chainKey));
		const refresh = (async () => {
			await apiFetch(
				`/user/balance?fresh=1&chainKey=${encodeURIComponent(chainKey)}`,
				{ user },
			);
			await mutate();
		})().finally(() => {
			refreshRefs.current.delete(chainKey);
			setRefreshingChainKeys((current) => {
				const next = new Set(current);
				next.delete(chainKey);
				return next;
			});
		});
		refreshRefs.current.set(chainKey, refresh);
		return refresh;
	}, [mutate, previewData, user]);
	return {
		...swr,
		data: previewData ?? swr.data,
		isLoading: previewData ? false : swr.isLoading,
		isValidating: previewData ? false : swr.isValidating,
		isRefreshingChain: (chainKey: string) => refreshingChainKeys.has(chainKey),
		refreshChainBalance,
	};
}

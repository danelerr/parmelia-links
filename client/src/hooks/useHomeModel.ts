import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import type { User } from "../lib/firebase";
import { SERVER_URL } from "../lib/api";
import { activeNetwork } from "../lib/activeNetwork";
import {
	fetchHomeModel,
	loadHomeCache,
	saveHomeCache,
	type HomeCacheRecord,
	type HomeReadModel,
} from "../lib/homeData";

const INVALIDATION_EVENT = "gatopago:home-invalidate";
const ACTIVE_REFRESH_MS = 10_000;
const SAFETY_REFRESH_BASE_MS = 60_000;

function stableJitter(uid: string): number {
	let hash = 0;
	for (let index = 0; index < uid.length; index++) {
		hash = (hash * 31 + uid.charCodeAt(index)) >>> 0;
	}
	return hash % 15_000;
}

function homeRefreshInterval(
	latest: HomeReadModel | undefined,
	visible: boolean,
	online: boolean,
	safetyJitter: number,
): number {
	if (!visible || !online) return 0;
	const active =
		!latest ||
		latest.balance.refreshing ||
		latest.balance.status !== "fresh" ||
		latest.operations.status !== "fresh" ||
		latest.operations.payments.length > 0 ||
		latest.operations.account.length > 0;
	return active
		? ACTIVE_REFRESH_MS
		: SAFETY_REFRESH_BASE_MS + safetyJitter;
}

export function useHomeModel(user: User, previewModel?: HomeReadModel) {
	const [cachedModel, setCachedModel] = useState<HomeReadModel | null>(null);
	const cacheRef = useRef<HomeCacheRecord | null>(null);
	const safetyJitter = stableJitter(user.uid);
	const key = `${SERVER_URL}/home`;

	const swr = useSWR(
		previewModel ? null : key,
		async (url: string) => {
			const result = await fetchHomeModel(
				user,
				url,
				cacheRef.current,
				activeNetwork.chainId,
			);
			const record: HomeCacheRecord = {
				key: `${user.uid}:${activeNetwork.chainId}`,
				schemaVersion: 1,
				uid: user.uid,
				chainId: activeNetwork.chainId,
				etag: result.etag,
				savedAt: new Date().toISOString(),
				model: result.model,
			};
			cacheRef.current = record;
			void saveHomeCache(
				user.uid,
				activeNetwork.chainId,
				result.model,
				result.etag,
			);
			return result.model;
		},
		{
			keepPreviousData: true,
			// App.tsx already seeds this key and starts the authenticated bootstrap.
			// Revalidating again on Home mount would duplicate the same /home request.
			revalidateOnMount: false,
			revalidateIfStale: true,
			revalidateOnFocus: true,
			revalidateOnReconnect: true,
			dedupingInterval: 5_000,
			refreshWhenHidden: false,
			refreshWhenOffline: false,
			refreshInterval: (latest?: HomeReadModel) =>
				homeRefreshInterval(
					latest,
					document.visibilityState === "visible",
					navigator.onLine,
					safetyJitter,
				),
		},
	);
	const mutateHome = swr.mutate;

	useEffect(() => {
		if (previewModel) return;
		let cancelled = false;
		void loadHomeCache(user.uid, activeNetwork.chainId).then((record) => {
			if (cancelled || !record) return;
			cacheRef.current = record;
			setCachedModel(record.model);
		});
		return () => {
			cancelled = true;
		};
	}, [previewModel, user.uid]);

	useEffect(() => {
		if (previewModel) return;
		const refresh = () => void mutateHome();
		window.addEventListener(INVALIDATION_EVENT, refresh);

		const channel =
			"BroadcastChannel" in window
				? new BroadcastChannel(
						`gatopago-home:${user.uid}:${activeNetwork.chainId}`,
					)
				: null;
		if (channel) channel.onmessage = refresh;

		const serviceWorkerRefresh = (event: MessageEvent) => {
			if (
				event.data &&
				typeof event.data === "object" &&
				(event.data.type === "GATOPAGO_HOME_INVALIDATE" ||
					event.data.type === "PARMELIA_HOME_INVALIDATE")
			) {
				refresh();
				channel?.postMessage({ type: "invalidate" });
			}
		};
		navigator.serviceWorker?.addEventListener("message", serviceWorkerRefresh);

		return () => {
			window.removeEventListener(INVALIDATION_EVENT, refresh);
			navigator.serviceWorker?.removeEventListener(
				"message",
				serviceWorkerRefresh,
			);
			channel?.close();
		};
	}, [mutateHome, previewModel, user.uid]);

	return {
		...swr,
		data: previewModel ?? swr.data ?? cachedModel ?? undefined,
		isLoading: previewModel ? false : swr.isLoading,
		isValidating: previewModel ? false : swr.isValidating,
		fromLocalCache: !previewModel && !swr.data && Boolean(cachedModel),
	};
}

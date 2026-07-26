import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import type { User } from "../lib/firebase";
import { SERVER_URL } from "../lib/api";
import { activeNetwork } from "../lib/activeNetwork";
import { pushAlreadyEnabled } from "../lib/push";
import {
	fetchHomeModel,
	loadHomeCache,
	saveHomeCache,
	type HomeCacheRecord,
	type HomeReadModel,
} from "../lib/homeData";

const INVALIDATION_EVENT = "parmelia:home-invalidate";
const SAFETY_REFRESH_BASE_MS = 60_000;

function stableJitter(uid: string): number {
	let hash = 0;
	for (let index = 0; index < uid.length; index++) {
		hash = (hash * 31 + uid.charCodeAt(index)) >>> 0;
	}
	return hash % 15_000;
}

export function invalidateHome(): void {
	window.dispatchEvent(new Event(INVALIDATION_EVENT));
}

export function useHomeModel(user: User) {
	const [cachedModel, setCachedModel] = useState<HomeReadModel | null>(null);
	const cacheRef = useRef<HomeCacheRecord | null>(null);
	const safetyJitter = stableJitter(user.uid);
	const key = `${SERVER_URL}/home`;

	const swr = useSWR(
		key,
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
			revalidateOnMount: false,
			revalidateIfStale: false,
			revalidateOnFocus: true,
			revalidateOnReconnect: true,
			dedupingInterval: 5_000,
			refreshWhenHidden: false,
			refreshWhenOffline: false,
			refreshInterval: (latest?: HomeReadModel) => {
				if (pushAlreadyEnabled()) return 0;
				if (document.visibilityState !== "visible" || !navigator.onLine) return 0;
				const observedAt = latest?.balance.observedAt;
				if (!observedAt) {
					return SAFETY_REFRESH_BASE_MS + safetyJitter;
				}
				const age = Date.now() - new Date(observedAt).getTime();
				return (
					Math.max(
						SAFETY_REFRESH_BASE_MS - Math.max(0, age),
						10_000,
					) + safetyJitter
				);
			},
		},
	);
	const mutateHome = swr.mutate;

	useEffect(() => {
		let cancelled = false;
		void loadHomeCache(user.uid, activeNetwork.chainId).then((record) => {
			if (cancelled || !record) return;
			cacheRef.current = record;
			setCachedModel(record.model);
		});
		return () => {
			cancelled = true;
		};
	}, [user.uid]);

	useEffect(() => {
		const refresh = () => void mutateHome();
		window.addEventListener(INVALIDATION_EVENT, refresh);

		const channel =
			"BroadcastChannel" in window
				? new BroadcastChannel(
						`parmelia-home:${user.uid}:${activeNetwork.chainId}`,
					)
				: null;
		if (channel) channel.onmessage = refresh;

		const serviceWorkerRefresh = (event: MessageEvent) => {
			if (
				event.data &&
				typeof event.data === "object" &&
				event.data.type === "PARMELIA_HOME_INVALIDATE"
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
	}, [mutateHome, user.uid]);

	return {
		...swr,
		data: swr.data ?? cachedModel ?? undefined,
		fromLocalCache: !swr.data && Boolean(cachedModel),
	};
}

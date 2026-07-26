import type { User } from "./firebase";
import { fetchWithAuth } from "./authFetch";

export type ReadModelStatus = "fresh" | "stale" | "unavailable";

export type HomeReadModel = {
	schemaVersion: 1;
	identity: {
		uid: string;
		username: string | null;
		displayName: string | null;
		socialUrl: string | null;
	};
	account: {
		walletAddress: string | null;
		chainId: number;
		chainKey: string;
		networkName: string;
	};
	balance: {
		tokens: Record<string, string>;
		savings: string | null;
		status: ReadModelStatus;
		observedAt: string | null;
		consistentThroughBlock: string | null;
		refreshing: boolean;
		assets: Record<
			string,
			{
				value: string | null;
				raw: string | null;
				status: ReadModelStatus;
			}
		>;
	};
	security: {
		status: ReadModelStatus;
		hasRegisteredPasskey: boolean;
	};
	activity: {
		status: ReadModelStatus;
		sent: Array<Record<string, unknown>>;
		received: Array<Record<string, unknown>>;
		source: "ledger";
	};
	operations: {
		status: ReadModelStatus;
		payments: Array<Record<string, unknown>>;
		account: Array<Record<string, unknown>>;
	};
	alerts: Array<{ code: string; severity: "info" | "warning" }>;
	stateVersion: string;
	observedAt: string;
	consistentThroughBlock: string | null;
};

export type HomeCacheRecord = {
	key: string;
	schemaVersion: 1;
	uid: string;
	chainId: number;
	etag: string | null;
	savedAt: string;
	model: HomeReadModel;
};

const DB_NAME = "parmelia-read-models";
const DB_VERSION = 1;
const STORE = "home";
const SCHEMA_VERSION = 1;

function cacheKey(uid: string, chainId: number): string {
	return `${uid}:${chainId}`;
}

function openDb(): Promise<IDBDatabase | null> {
	if (!("indexedDB" in window)) return Promise.resolve(null);
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (!db.objectStoreNames.contains(STORE)) {
				db.createObjectStore(STORE, { keyPath: "key" });
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

function validRecord(
	value: unknown,
	uid: string,
	chainId: number,
): value is HomeCacheRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<HomeCacheRecord>;
	return (
		record.schemaVersion === SCHEMA_VERSION &&
		record.uid === uid &&
		record.chainId === chainId &&
		record.model?.schemaVersion === SCHEMA_VERSION &&
		record.model.identity.uid === uid &&
		record.model.account.chainId === chainId
	);
}

export async function loadHomeCache(
	uid: string,
	chainId: number,
): Promise<HomeCacheRecord | null> {
	const db = await openDb().catch(() => null);
	if (!db) return null;
	return new Promise((resolve) => {
		const transaction = db.transaction(STORE, "readonly");
		const request = transaction.objectStore(STORE).get(cacheKey(uid, chainId));
		request.onsuccess = () =>
			resolve(validRecord(request.result, uid, chainId) ? request.result : null);
		request.onerror = () => resolve(null);
		transaction.oncomplete = () => db.close();
		transaction.onabort = () => db.close();
	});
}

export async function saveHomeCache(
	uid: string,
	chainId: number,
	model: HomeReadModel,
	etag: string | null,
): Promise<void> {
	if (
		model.schemaVersion !== SCHEMA_VERSION ||
		model.identity.uid !== uid ||
		model.account.chainId !== chainId
	) {
		return;
	}
	const db = await openDb().catch(() => null);
	if (!db) return;
	await new Promise<void>((resolve) => {
		const transaction = db.transaction(STORE, "readwrite");
		transaction.objectStore(STORE).put({
			key: cacheKey(uid, chainId),
			schemaVersion: SCHEMA_VERSION,
			uid,
			chainId,
			etag,
			savedAt: new Date().toISOString(),
			model,
		} satisfies HomeCacheRecord);
		transaction.oncomplete = () => {
			db.close();
			resolve();
		};
		transaction.onerror = () => {
			db.close();
			resolve();
		};
		transaction.onabort = () => {
			db.close();
			resolve();
		};
	});
}

export async function clearHomeCache(uid?: string): Promise<void> {
	const db = await openDb().catch(() => null);
	if (!db) return;
	await new Promise<void>((resolve) => {
		const transaction = db.transaction(STORE, "readwrite");
		const store = transaction.objectStore(STORE);
		if (!uid) {
			store.clear();
		} else {
			const request = store.openCursor();
			request.onsuccess = () => {
				const cursor = request.result;
				if (!cursor) return;
				const value = cursor.value as Partial<HomeCacheRecord>;
				if (value.uid === uid) cursor.delete();
				cursor.continue();
			};
		}
		transaction.oncomplete = () => {
			db.close();
			resolve();
		};
		transaction.onerror = () => {
			db.close();
			resolve();
		};
		transaction.onabort = () => {
			db.close();
			resolve();
		};
	});
}

export async function fetchHomeModel(
	user: User,
	url: string,
	cached: HomeCacheRecord | null,
	expectedChainId: number,
): Promise<{ model: HomeReadModel; etag: string | null }> {
	const headers = new Headers();
	if (cached?.etag) headers.set("If-None-Match", cached.etag);
	let response = await fetchWithAuth(user, url, { headers });
	if (response.status === 304 && cached) {
		return { model: cached.model, etag: cached.etag };
	}
	// A stale ETag without its corresponding IndexedDB row is not useful.
	if (response.status === 304) {
		response = await fetchWithAuth(user, url);
	}
	if (!response.ok) throw new Error("Home API error");
	const model = (await response.json()) as HomeReadModel;
	if (
		model.schemaVersion !== SCHEMA_VERSION ||
		model.identity.uid !== user.uid ||
		model.account.chainId !== expectedChainId
	) {
		throw new Error("Home response scope mismatch");
	}
	return { model, etag: response.headers.get("ETag") };
}

export const __test = {
	cacheKey,
	validRecord,
};

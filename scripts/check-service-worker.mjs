import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile("client/public/sw.js", "utf8");

async function waitFor(condition, message) {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (condition()) return;
		await new Promise((resolve) => setImmediate(resolve));
	}
	assert.fail(message);
}

const listeners = new Map();
let skippedWaiting = false;
let precachePuts = 0;
let cacheMatch = null;
let cachePut = async () => { precachePuts += 1; };
let fetchResponse = new Response("ok", { status: 200 });

const cache = {
	match: async () => cacheMatch,
	put: (...args) => cachePut(...args),
};

const worker = {
	location: { origin: "https://app.example" },
	addEventListener: (type, handler) => listeners.set(type, handler),
	skipWaiting: async () => {
		skippedWaiting = true;
	},
	clients: {
		claim: async () => {},
		matchAll: async () => [],
		openWindow: async () => {},
	},
	registration: {
		showNotification: async () => {},
	},
};

vm.runInNewContext(source, {
	self: worker,
	caches: {
		open: async () => cache,
		keys: async () => [],
		delete: async () => true,
	},
	fetch: async () => fetchResponse,
	URL,
	Response,
	setTimeout,
	clearTimeout,
	console,
}, { filename: "client/public/sw.js" });

const install = listeners.get("install");
assert.equal(typeof install, "function", "service worker must register install");
let installPromise;
install({ waitUntil: (promise) => { installPromise = promise; } });
assert.equal(skippedWaiting, false, "skipWaiting must wait for a complete precache");
await installPromise;
assert.ok(precachePuts > 1, "app shell and static assets must be precached");
assert.equal(skippedWaiting, true, "a complete install may activate immediately");

const fetchHandler = listeners.get("fetch");
assert.equal(typeof fetchHandler, "function", "service worker must register fetch");

for (const authPath of ["/__/auth/iframe", "/__/auth/handler", "/__/firebase/init.json"]) {
	let intercepted = false;
	fetchHandler({
		request: {
			url: `https://app.example${authPath}`,
			method: "GET",
			mode: "navigate",
		},
		respondWith: () => { intercepted = true; },
	});
	assert.equal(intercepted, false, `${authPath} must bypass the service worker`);
}

let navigationCacheWrites = 0;
cachePut = async () => { navigationCacheWrites += 1; };
fetchResponse = new Response("app", {
	status: 200,
	headers: { "Content-Type": "text/html" },
});
let navigationResponsePromise;
fetchHandler({
	request: {
		url: "https://app.example/settings",
		method: "GET",
		mode: "navigate",
	},
	respondWith: (promise) => { navigationResponsePromise = promise; },
});
assert.equal((await navigationResponsePromise).status, 200);
assert.equal(
	navigationCacheWrites,
	0,
	"successful navigations must never overwrite the atomically installed shell",
);

let resolveAssetPut;
cachePut = () => new Promise((resolve) => { resolveAssetPut = resolve; });
fetchResponse = new Response("asset", { status: 200 });
let assetResponsePromise;
fetchHandler({
	request: {
		url: "https://app.example/assets/app-hash.js",
		method: "GET",
		destination: "script",
		mode: "cors",
	},
	respondWith: (promise) => { assetResponsePromise = promise; },
});
let assetSettled = false;
void assetResponsePromise.then(() => { assetSettled = true; });
await waitFor(
	() => typeof resolveAssetPut === "function",
	"asset caching did not reach cache.put",
);
assert.equal(assetSettled, false, "asset response must retain the cache write lifetime");
resolveAssetPut();
assert.equal((await assetResponsePromise).status, 200);

const notificationClick = listeners.get("notificationclick");
assert.equal(typeof notificationClick, "function", "service worker must register notification clicks");
let resolveNavigation;
let focused = false;
worker.clients.matchAll = async () => [{
	navigate: () => new Promise((resolve) => { resolveNavigation = resolve; }),
	focus: async () => { focused = true; },
}];
let clickPromise;
notificationClick({
	notification: {
		data: { link: "/payments/123" },
		close: () => {},
	},
	waitUntil: (promise) => { clickPromise = promise; },
});
await waitFor(
	() => typeof resolveNavigation === "function",
	"notification handling did not reach client.navigate",
);
assert.equal(focused, false, "notification focus must wait for navigation");
resolveNavigation();
await clickPromise;
assert.equal(focused, true, "notification target must be focused after navigation");

console.log("Service worker lifecycle checks passed.");

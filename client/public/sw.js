// Parmelia service worker — minimal and safe by design:
//   - hashed build assets (/assets/*): cache-first (immutable by filename)
//   - navigations: network-first with the cached shell as offline fallback
//   - everything else (API, cross-origin, non-GET): untouched — money flows
//     must NEVER be served from a cache.
const CACHE = "parmelia-shell-v1";

self.addEventListener("install", () => {
	self.skipWaiting();
});

self.addEventListener("activate", (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener("fetch", (event) => {
	const { request } = event;
	if (request.method !== "GET") return;

	const url = new URL(request.url);
	if (url.origin !== self.location.origin) return;

	// Immutable build assets → cache-first.
	if (url.pathname.startsWith("/assets/")) {
		event.respondWith(
			caches.open(CACHE).then(async (cache) => {
				const hit = await cache.match(request);
				if (hit) return hit;
				const res = await fetch(request);
				if (res.ok) cache.put(request, res.clone());
				return res;
			}),
		);
		return;
	}

	// App navigations → network-first, offline falls back to the cached shell.
	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request)
				.then((res) => {
					const copy = res.clone();
					caches.open(CACHE).then((cache) => cache.put("/index.html", copy));
					return res;
				})
				.catch(() => caches.match("/index.html")),
		);
	}
});

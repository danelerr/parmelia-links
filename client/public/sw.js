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

// ===== FCM web push =====
// FCM delivers a Web Push event; we render it ourselves (no firebase SDK SW).
self.addEventListener("push", (event) => {
	let payload = {};
	try {
		payload = event.data ? event.data.json() : {};
	} catch {
		payload = {};
	}
	const info = payload.notification || payload.data || {};
	const title = info.title || "Parmelia";
	const body = info.body || "";
	const link = (payload.data && payload.data.link) || "/";
	event.waitUntil(
		self.registration.showNotification(title, {
			body,
			icon: "/parmelia.svg",
			badge: "/parmelia.svg",
			data: { link },
		}),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const link = (event.notification.data && event.notification.data.link) || "/";
	event.waitUntil(
		self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
			for (const client of list) {
				if ("focus" in client) {
					client.navigate(link);
					return client.focus();
				}
			}
			return self.clients.openWindow(link);
		}),
	);
});

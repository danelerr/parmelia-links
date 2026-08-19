// GatoPago service worker — minimal and safe by design:
//   - hashed build assets (/assets/*): cache-first (immutable by filename)
//   - navigations: network-first with the cached shell as offline fallback
//   - everything else (API, cross-origin, non-GET): untouched — money flows
//     must NEVER be served from a cache.
const CACHE = "gatopago-shell-v6";
const SHELL = "/index.html";
const PRECACHE = [
	SHELL,
	"/manifest.webmanifest",
	"/favicon.ico",
	"/apple-touch-icon.png",
	"/gatopago.svg",
	"/gatopago-icon.svg",
	"/icon-192.png",
	"/icon-512.png",
	"/maskable-192.png",
	"/maskable-512.png",
	"/icon-monochrome.svg",
	"/badge-96.png",
];
const STATIC_ROOT_ASSETS = new Set(PRECACHE.slice(1));

async function precacheAppShell() {
	const cache = await caches.open(CACHE);
	const shellResponse = await fetch(SHELL, { cache: "reload" });
	if (!shellResponse.ok) {
		throw new Error(`Unable to precache app shell (${shellResponse.status})`);
	}

	// The service worker is copied from public/ and cannot know Vite's hashed
	// bundle names ahead of time. Discover every same-origin build asset linked
	// by the generated HTML so the first successful visit is genuinely offline
	// capable, even before a controlled page has made any asset requests.
	const html = await shellResponse.clone().text();
	const buildAssets = Array.from(
		html.matchAll(/\b(?:src|href)=["']([^"']+)["']/g),
		(match) => new URL(match[1], self.location.origin),
	)
		.filter(
			(url) =>
				url.origin === self.location.origin &&
				url.pathname.startsWith("/assets/"),
		)
		.map((url) => `${url.pathname}${url.search}`);

	await cache.put(SHELL, shellResponse);
	await Promise.all(
		[...new Set([...PRECACHE.slice(1), ...buildAssets])].map(async (path) => {
			const response = await fetch(path, { cache: "reload" });
			if (!response.ok) {
				throw new Error(`Unable to precache ${path} (${response.status})`);
			}
			await cache.put(path, response);
		}),
	);
}

self.addEventListener("install", (event) => {
	// Keep the prior worker active unless the complete new shell was cached.
	// A partially installed release must not replace a working offline version.
	event.waitUntil(precacheAppShell());
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
	if (url.pathname.startsWith("/assets/") || STATIC_ROOT_ASSETS.has(url.pathname)) {
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
	// Only OK responses are cached: a 404/500 (or an error page) must never
	// replace the working shell and get served offline forever.
	if (request.mode === "navigate") {
		event.respondWith(
			fetch(request)
				.then((res) => {
					if (res.ok) {
						const copy = res.clone();
						caches.open(CACHE).then((cache) => cache.put(SHELL, copy));
					}
					return res;
				})
				.catch(() => caches.match(SHELL)),
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
	const isHomeInvalidation =
		payload.data && payload.data.type === "home.invalidate";
	const title = info.title || "GatoPago";
	const body = info.body || "";
	const link = (payload.data && payload.data.link) || "/";
	const invalidateWindows = self.clients
				.matchAll({ type: "window", includeUncontrolled: true })
				.then((clients) => {
					for (const client of clients) {
						client.postMessage({
							type: "GATOPAGO_HOME_INVALIDATE",
							stateVersion:
								payload.data && payload.data.stateVersion,
						});
					}
				});
	if (isHomeInvalidation) {
		event.waitUntil(invalidateWindows);
		return;
	}
	event.waitUntil(
		Promise.all([
			invalidateWindows,
			self.registration.showNotification(title, {
				body,
				icon: "/icon-192.png",
				badge: "/badge-96.png",
				data: { link },
			}),
		]),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const rawLink = (event.notification.data && event.notification.data.link) || "/";
	let link = "/";
	try {
		const target = new URL(rawLink, self.location.origin);
		if (target.origin === self.location.origin) {
			link = `${target.pathname}${target.search}${target.hash}`;
		}
	} catch {
		/* malformed or cross-origin notification links fall back to Home */
	}
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

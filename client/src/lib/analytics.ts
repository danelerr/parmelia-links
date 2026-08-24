// GA4 via Firebase - dormant until VITE_FIREBASE_MEASUREMENT_ID is set, so the
// app works identically before Analytics is enabled in the Firebase console.

import { app } from "./firebase";
import type { Analytics } from "firebase/analytics";

let analytics: Analytics | null = null;
let analyticsModule: typeof import("firebase/analytics") | null = null;

async function loadAnalytics(cancelled: () => boolean) {
	try {
		const module = await import("firebase/analytics");
		if (cancelled() || !(await module.isSupported())) return;
		analyticsModule = module;
		analytics = module.getAnalytics(app);
	} catch {
		/* analytics is optional and must never affect product flows */
	}
}

export function initAnalytics(): () => void {
	if (!import.meta.env.VITE_FIREBASE_MEASUREMENT_ID) return () => {};
	let cancelled = false;
	const start = () => void loadAnalytics(() => cancelled);
	const idleWindow = window as unknown as {
		requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
		cancelIdleCallback?: (handle: number) => void;
	};

	if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
		const handle = idleWindow.requestIdleCallback(start, { timeout: 3_000 });
		return () => {
			cancelled = true;
			idleWindow.cancelIdleCallback?.(handle);
		};
	}

	const handle = globalThis.setTimeout(start, 1_500);
	return () => {
		cancelled = true;
		globalThis.clearTimeout(handle);
	};
}

/** Funnel event. No-op until analytics is initialized. */
export function track(event: string, params?: Record<string, unknown>) {
	if (!analytics || !analyticsModule) return;
	try {
		analyticsModule.logEvent(analytics, event, params);
	} catch {
		/* never let analytics break a flow */
	}
}

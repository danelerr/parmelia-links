// GA4 via Firebase - dormant until VITE_FIREBASE_MEASUREMENT_ID is set, so the
// app works identically before Analytics is enabled in the Firebase console.

import { app } from "./firebase";
import { getAnalytics, isSupported, logEvent, type Analytics } from "firebase/analytics";

let analytics: Analytics | null = null;

export function initAnalytics() {
	if (!import.meta.env.VITE_FIREBASE_MEASUREMENT_ID) return;
	void isSupported()
		.then((ok) => {
			if (ok) analytics = getAnalytics(app);
		})
		.catch(() => {});
}

/** Funnel event. No-op until analytics is initialized. */
export function track(event: string, params?: Record<string, unknown>) {
	if (!analytics) return;
	try {
		logEvent(analytics, event, params);
	} catch {
		/* never let analytics break a flow */
	}
}

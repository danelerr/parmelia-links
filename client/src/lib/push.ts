// FCM web push opt-in. Dormant until VITE_FIREBASE_VAPID_KEY is set and the
// browser supports it (iOS only supports web push for INSTALLED PWAs).

import { app, type User } from "./firebase";
import { getMessaging, getToken, isSupported, onMessage } from "firebase/messaging";
import { apiFetch } from "./api";
import { notifySuccess } from "./notify";

const VAPID_KEY = import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined;

export async function pushSupported(): Promise<boolean> {
	if (!VAPID_KEY || !("serviceWorker" in navigator) || !("Notification" in window)) {
		return false;
	}
	try {
		return await isSupported();
	} catch {
		return false;
	}
}

/** Already granted permission this session/device? */
export function pushAlreadyEnabled(): boolean {
	return "Notification" in window && Notification.permission === "granted";
}

async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
	const existing = await navigator.serviceWorker.getRegistration();
	return existing ?? (await navigator.serviceWorker.register("/sw.js"));
}

/**
 * Request notification permission, get the FCM token and register it server-side.
 * Returns true on success. Must be called from a user gesture (browser rule).
 */
export async function enablePush(user: User): Promise<boolean> {
	if (!(await pushSupported())) return false;

	const permission = await Notification.requestPermission();
	if (permission !== "granted") return false;

	const registration = await ensureServiceWorker();
	const messaging = getMessaging(app);
	const token = await getToken(messaging, {
		vapidKey: VAPID_KEY,
		serviceWorkerRegistration: registration,
	});
	if (!token) return false;

	await apiFetch("/user/push-token", { user, method: "PUT", body: { token } });

	// Foreground messages: show a calm in-app toast instead of an OS banner.
	onMessage(messaging, (payload) => {
		const title = payload.notification?.title || payload.data?.title;
		const body = payload.notification?.body || payload.data?.body;
		if (title) notifySuccess(title, body);
	});

	return true;
}

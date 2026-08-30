import { initializeApp } from "firebase/app";
import { clearHomeCache } from "./homeData";
import {
	browserLocalPersistence,
	EmailAuthProvider,
	getAuth,
	GoogleAuthProvider,
	getRedirectResult,
	isSignInWithEmailLink,
	onAuthStateChanged,
	reauthenticateWithCredential,
	setPersistence,
	signInWithEmailLink,
	signInWithPopup,
	signInWithRedirect,
	signOut,
	type User,
	type UserCredential,
} from "firebase/auth";

const firebaseConfig = {
	apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
	authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
	projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
	storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
	messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
	appId: import.meta.env.VITE_FIREBASE_APP_ID,
	measurementId: import.meta.env.VITE_FIREBASE_MEASUREMENT_ID,
};

export const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const EMAIL_LINK_REQUEST_KEY = "gatopago:firebase-email-link:v1";
const EMAIL_LINK_REQUEST_TTL_MS = 60 * 60 * 1_000;

export type EmailLinkPurpose = "signin" | "recovery";

type PendingEmailLinkRequest = {
	email: string;
	purpose: EmailLinkPurpose;
	requestedAt: number;
};

const emailLinkCompletions = new Map<string, Promise<UserCredential>>();

void setPersistence(auth, browserLocalPersistence).catch((error) => {
	console.error("Failed to set Firebase auth persistence", error);
});

// Complete any pending redirect sign-in (used by the popup fallback and inside
// installed PWAs). The signed-in user surfaces through onAuthChange; this call
// just lets redirect-specific errors be logged instead of silently swallowed.
void getRedirectResult(auth).catch((error) => {
	console.error("Redirect sign-in failed", error);
});

const googleProvider = new GoogleAuthProvider();

// Popups are unreliable inside an installed PWA — on iOS they open a detached
// Safari view that never returns the result — and some browsers block them.
function isStandalonePWA() {
	return (
		window.matchMedia?.("(display-mode: standalone)").matches ||
		(window.navigator as Navigator & { standalone?: boolean }).standalone === true
	);
}

// Popup failures where a full-page redirect is the correct recovery. User
// cancellation (popup-closed-by-user) is intentionally excluded so we never
// force someone into a login they just dismissed.
const POPUP_FALLBACK_CODES = new Set([
	"auth/popup-blocked",
	"auth/operation-not-supported-in-this-environment",
	"auth/web-storage-unsupported",
]);

/**
 * Sign in with a provider. Returns the credential on the popup path; returns
 * null when a redirect was started instead — the page navigates away and the
 * result is picked up by onAuthChange on return.
 */
async function signInWithProvider(
	provider: GoogleAuthProvider,
): Promise<UserCredential | null> {
	if (isStandalonePWA()) {
		await signInWithRedirect(auth, provider);
		return null;
	}
	try {
		return await signInWithPopup(auth, provider);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code && POPUP_FALLBACK_CODES.has(code)) {
			await signInWithRedirect(auth, provider);
			return null;
		}
		throw error;
	}
}

export async function signInWithGoogle() {
	return signInWithProvider(googleProvider);
}

export function rememberEmailLinkRequest(email: string, purpose: EmailLinkPurpose): void {
	try {
		const value: PendingEmailLinkRequest = {
			email: email.trim().toLowerCase(),
			purpose,
			requestedAt: Date.now(),
		};
		window.localStorage.setItem(EMAIL_LINK_REQUEST_KEY, JSON.stringify(value));
	} catch {
		// A link still works on this or another device after the user re-enters
		// their email. Storage is a convenience, never part of the proof.
	}
}

export function pendingEmailLinkRequest(): PendingEmailLinkRequest | null {
	try {
		const raw = window.localStorage.getItem(EMAIL_LINK_REQUEST_KEY);
		if (!raw) return null;
		const value = JSON.parse(raw) as Partial<PendingEmailLinkRequest>;
		if (
			typeof value.email !== "string" ||
			(value.purpose !== "signin" && value.purpose !== "recovery") ||
			typeof value.requestedAt !== "number" ||
			Date.now() - value.requestedAt > EMAIL_LINK_REQUEST_TTL_MS
		) {
			window.localStorage.removeItem(EMAIL_LINK_REQUEST_KEY);
			return null;
		}
		return value as PendingEmailLinkRequest;
	} catch {
		return null;
	}
}

export function clearPendingEmailLinkRequest(): void {
	try {
		window.localStorage.removeItem(EMAIL_LINK_REQUEST_KEY);
	} catch {
		// Nothing sensitive remains valid solely because local storage is blocked.
	}
}

export function isFirebaseEmailLink(url = window.location.href): boolean {
	try {
		return isSignInWithEmailLink(auth, url);
	} catch {
		return false;
	}
}

export function emailLinkFlow(url = window.location.href): {
	flow: EmailLinkPurpose;
	challenge: string | null;
} {
	try {
		const link = new URL(url);
		const nested = link.searchParams.get("continueUrl");
		const context = nested ? new URL(nested) : link;
		return {
			flow: context.searchParams.get("flow") === "recovery" ? "recovery" : "signin",
			challenge: context.searchParams.get("challenge"),
		};
	} catch {
		return { flow: "signin", challenge: null };
	}
}

/** Complete one Firebase link once, even when React Strict Mode re-runs effects. */
export async function completeFirebaseEmailLink(
	url: string,
	email: string,
	purpose: EmailLinkPurpose,
) {
	const normalizedEmail = email.trim().toLowerCase();
	const key = `${purpose}\n${url}\n${normalizedEmail}`;
	let completion = emailLinkCompletions.get(key);
	if (!completion) {
		completion = (
			purpose === "recovery" && auth.currentUser
				? reauthenticateWithCredential(
					auth.currentUser,
					EmailAuthProvider.credentialWithLink(normalizedEmail, url),
				)
				: signInWithEmailLink(auth, normalizedEmail, url)
		).then(async (result) => {
			await result.user.getIdToken(true);
			return result;
		}).catch((error) => {
			// Strict Mode and duplicate clicks share one in-flight exchange, but a
			// transient failure must not poison this link for the page lifetime.
			// Firebase consumes the OOB code only after a successful exchange.
			emailLinkCompletions.delete(key);
			throw error;
		});
		emailLinkCompletions.set(key, completion);
	}
	return completion;
}

export async function logOut() {
	const uid = auth.currentUser?.uid;
	if (uid) {
		await clearHomeCache(uid);
	}
	return signOut(auth);
}

export function onAuthChange(callback: (user: User | null) => void) {
	return onAuthStateChanged(auth, callback);
}

export type { User };

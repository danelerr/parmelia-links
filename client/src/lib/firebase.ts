import { initializeApp } from "firebase/app";

import {
	browserLocalPersistence,
	getAuth,
	GoogleAuthProvider,
	OAuthProvider,
	getRedirectResult,
	isSignInWithEmailLink,
	onAuthStateChanged,
	sendSignInLinkToEmail,
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
export const auth = getAuth(app);

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
	provider: GoogleAuthProvider | OAuthProvider,
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

export async function signInWithApple() {
	const provider = new OAuthProvider("apple.com");
	provider.addScope("email");
	provider.addScope("name");
	return signInWithProvider(provider);
}

// ===== Email magic link (passwordless) =====

const EMAIL_STORAGE_KEY = "parmelia:emailForSignIn";

/** Send a sign-in link to `email`. The link returns to /login on this origin. */
export async function sendEmailLink(email: string) {
	await sendSignInLinkToEmail(auth, email, {
		url: `${window.location.origin}/login`,
		handleCodeInApp: true,
	});
	// Needed to complete sign-in when the user returns via the email link.
	window.localStorage.setItem(EMAIL_STORAGE_KEY, email);
}

/** True if the current URL is a Firebase email sign-in link. */
export function isEmailSignInLink(url: string) {
	return isSignInWithEmailLink(auth, url);
}

/**
 * Complete an email-link sign-in from the current URL. Falls back to the passed
 * email if the original device's localStorage isn't available (different device).
 */
export async function completeEmailLink(url: string, fallbackEmail?: string) {
	const email = window.localStorage.getItem(EMAIL_STORAGE_KEY) || fallbackEmail;
	if (!email) throw new Error("NEED_EMAIL");
	const result = await signInWithEmailLink(auth, email, url);
	window.localStorage.removeItem(EMAIL_STORAGE_KEY);
	return result;
}

export async function logOut() {
	return signOut(auth);
}

export function onAuthChange(callback: (user: User | null) => void) {
	return onAuthStateChanged(auth, callback);
}

export type { User };

import { initializeApp } from "firebase/app";
import { clearHomeCache } from "./homeData";
import {
	browserLocalPersistence,
	getAuth,
	GoogleAuthProvider,
	getRedirectResult,
	onAuthStateChanged,
	setPersistence,
	signInWithCustomToken,
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

/** Complete server-verified email OTP authentication with a Firebase custom token. */
export async function signInWithEmailCodeToken(customToken: string) {
	const result = await signInWithCustomToken(auth, customToken);
	await result.user.getIdToken(true);
	return result;
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

import { initializeApp } from "firebase/app";

import {
	browserLocalPersistence,
	getAuth,
	GoogleAuthProvider,
	OAuthProvider,
	isSignInWithEmailLink,
	onAuthStateChanged,
	sendSignInLinkToEmail,
	setPersistence,
	signInWithEmailLink,
	signInWithPopup,
	signOut,
	type User,
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

const googleProvider = new GoogleAuthProvider();

export async function signInWithGoogle() {
	return signInWithPopup(auth, googleProvider);
}

export async function signInWithApple() {
	const provider = new OAuthProvider("apple.com");
	provider.addScope("email");
	provider.addScope("name");
	return signInWithPopup(auth, provider);
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

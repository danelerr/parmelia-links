import { initializeApp } from "firebase/app";
import {
	browserLocalPersistence,
	getAuth,
	getRedirectResult,
	GoogleAuthProvider,
	isSignInWithEmailLink,
	onAuthStateChanged,
	sendSignInLinkToEmail,
	setPersistence,
	signInWithEmailLink,
	signInWithPopup,
	signInWithRedirect,
	signOut,
	type User,
} from "firebase/auth";

// Same Firebase project as the consumer app → same account / SSO. The dashboard
// only needs identity (to manage keys/webhooks); it never signs transactions, so
// no passkey is involved here.
const firebaseConfig = {
	apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
	authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
	projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
	storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
	messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
	appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

void setPersistence(auth, browserLocalPersistence).catch(() => {});
void getRedirectResult(auth).catch(() => {});

const googleProvider = new GoogleAuthProvider();

export async function signInWithGoogle() {
	try {
		await signInWithPopup(auth, googleProvider);
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") {
			await signInWithRedirect(auth, googleProvider);
			return;
		}
		throw error;
	}
}

const EMAIL_KEY = "parmelia:dash:emailForSignIn";

export async function sendEmailLink(email: string) {
	await sendSignInLinkToEmail(auth, email, {
		url: `${window.location.origin}/login`,
		handleCodeInApp: true,
	});
	window.localStorage.setItem(EMAIL_KEY, email);
}

export function isEmailSignInLink(url: string) {
	return isSignInWithEmailLink(auth, url);
}

export async function completeEmailLink(url: string, fallbackEmail?: string) {
	const email = window.localStorage.getItem(EMAIL_KEY) || fallbackEmail;
	if (!email) throw new Error("NEED_EMAIL");
	const result = await signInWithEmailLink(auth, email, url);
	window.localStorage.removeItem(EMAIL_KEY);
	return result;
}

export async function logOut() {
	return signOut(auth);
}

export function onAuthChange(cb: (user: User | null) => void) {
	return onAuthStateChanged(auth, cb);
}

export type { User };

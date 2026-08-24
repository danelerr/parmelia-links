import { initializeApp } from "firebase/app";
import {
	browserLocalPersistence,
	getAuth,
	getRedirectResult,
	GoogleAuthProvider,
	onAuthStateChanged,
	setPersistence,
	signInWithCustomToken,
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

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

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

export async function signInWithEmailCodeToken(customToken: string) {
	const result = await signInWithCustomToken(auth, customToken);
	await result.user.getIdToken(true);
	return result;
}

export async function logOut() {
	return signOut(auth);
}

export function onAuthChange(cb: (user: User | null) => void) {
	return onAuthStateChanged(auth, cb);
}

export type { User };

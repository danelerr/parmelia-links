// API key generation + hashing (Web Crypto, Workers-native).
//
// The full secret key is shown to the merchant exactly ONCE at creation. We only
// ever store its SHA-256 hash; auth re-hashes the presented key and looks it up.
// SHA-256 (not bcrypt) is fine here because the secret is high-entropy random,
// not a low-entropy human password.

export type ApiKeyMode = "test" | "live";

function toHex(buffer: ArrayBuffer): string {
	return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Hex-encoded random token. */
export function randomToken(bytes = 24): string {
	const arr = new Uint8Array(bytes);
	crypto.getRandomValues(arr);
	return toHex(arr.buffer);
}

export async function sha256Hex(input: string): Promise<string> {
	const data = new TextEncoder().encode(input);
	return toHex(await crypto.subtle.digest("SHA-256", data));
}

/**
 * Create a new API key. Returns the one-time plaintext, a display prefix, and
 * the hash to persist. Format: `sk_<mode>_<48 hex chars>`.
 */
export async function generateApiKey(
	mode: ApiKeyMode,
): Promise<{ plaintext: string; prefix: string; hash: string }> {
	const plaintext = `sk_${mode}_${randomToken(24)}`;
	const prefix = plaintext.slice(0, 14); // sk_test_a1b2c3
	const hash = await sha256Hex(plaintext);
	return { plaintext, prefix, hash };
}

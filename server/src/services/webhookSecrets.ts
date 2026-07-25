import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { logWarn } from "./logger";

const LEGACY_PREFIX = "enc:v1:";
const PREFIX = "enc:v2:";
const DEFAULT_KEY_ID = "primary";
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
let warnedPlaintext = false;

type KeySpec = { id: string; bytes: Uint8Array };

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function keyBytes(raw: string, label: string): Uint8Array {
	let bytes: Uint8Array;
	try {
		bytes = /^[0-9a-fA-F]{64}$/.test(raw)
			? Uint8Array.from(raw.match(/.{2}/g)!, (pair) => Number.parseInt(pair, 16))
			: base64ToBytes(raw);
	} catch {
		throw new Error(`${label} must be valid base64 or 64-character hex`);
	}
	if (bytes.byteLength !== 32) throw new Error(`${label} must contain exactly 32 bytes`);
	return bytes;
}

function currentKey(env: Bindings): KeySpec | null {
	const raw = env.WEBHOOK_SECRET_ENCRYPTION_KEY?.trim();
	if (!raw) return null;
	const id = env.WEBHOOK_SECRET_ENCRYPTION_KEY_ID?.trim() || DEFAULT_KEY_ID;
	if (!KEY_ID_PATTERN.test(id)) {
		throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEY_ID must be 1-32 alphanumeric, underscore or dash characters");
	}
	return { id, bytes: keyBytes(raw, "WEBHOOK_SECRET_ENCRYPTION_KEY") };
}

function previousKeys(env: Bindings): KeySpec[] {
	const raw = env.WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS?.trim();
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS must be a JSON object");
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS must be a JSON object");
	}
	return Object.entries(parsed as Record<string, unknown>).map(([id, value]) => {
		if (!KEY_ID_PATTERN.test(id) || typeof value !== "string") {
			throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS contains an invalid key id or value");
		}
		return { id, bytes: keyBytes(value.trim(), `previous webhook key '${id}'`) };
	});
}

export function validateWebhookKeyring(env: Bindings): { activeKeyId: string | null; previousKeyIds: string[] } {
	const current = currentKey(env);
	const previous = previousKeys(env);
	if (current && previous.some((spec) => spec.id === current.id)) {
		throw new Error("The active webhook encryption key id must not appear in previous keys");
	}
	return { activeKeyId: current?.id ?? null, previousKeyIds: previous.map((spec) => spec.id) };
}

async function importCryptoKey(spec: KeySpec): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", toArrayBuffer(spec.bytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

function additionalData(keyId: string): ArrayBuffer {
	return toArrayBuffer(new TextEncoder().encode(`${PREFIX}${keyId}`));
}

async function encryptWithCurrentKey(spec: KeySpec, plaintext: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv: toArrayBuffer(iv), additionalData: additionalData(spec.id) },
		await importCryptoKey(spec),
		toArrayBuffer(new TextEncoder().encode(plaintext)),
	);
	return `${PREFIX}${spec.id}:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(ciphertext))}`;
}

async function decryptV2(spec: KeySpec, ivEncoded: string, ciphertextEncoded: string): Promise<string> {
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: toArrayBuffer(base64ToBytes(ivEncoded)),
			additionalData: additionalData(spec.id),
		},
		await importCryptoKey(spec),
		toArrayBuffer(base64ToBytes(ciphertextEncoded)),
	);
	return new TextDecoder().decode(plaintext);
}

async function decryptLegacy(
	specs: KeySpec[],
	ivEncoded: string,
	ciphertextEncoded: string,
): Promise<string> {
	for (const spec of specs) {
		try {
			const plaintext = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: toArrayBuffer(base64ToBytes(ivEncoded)) },
				await importCryptoKey(spec),
				toArrayBuffer(base64ToBytes(ciphertextEncoded)),
			);
			return new TextDecoder().decode(plaintext);
		} catch {
			// V1 ciphertext has no key identifier, so every configured key must be tried.
		}
	}
	throw new Error("No configured webhook encryption key can decrypt this legacy secret");
}

export function activeWebhookSecretPrefix(env: Bindings): string | null {
	const spec = currentKey(env);
	return spec ? `${PREFIX}${spec.id}:` : null;
}

export function isEncryptedWebhookSecret(value: string): boolean {
	return value.startsWith(PREFIX) || value.startsWith(LEGACY_PREFIX);
}

export async function encryptWebhookSecret(env: Bindings, plaintext: string): Promise<string> {
	if (isEncryptedWebhookSecret(plaintext)) return plaintext;
	const spec = currentKey(env);
	if (!spec) {
		if (!getNetworkConfig(env.CHAIN_KEY).isTestnet) {
			throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEY is required on mainnet");
		}
		if (!warnedPlaintext) {
			warnedPlaintext = true;
			logWarn("webhook_secret_plaintext_testnet", { testnetOnly: true });
		}
		return plaintext;
	}
	return encryptWithCurrentKey(spec, plaintext);
}

export async function decryptWebhookSecret(env: Bindings, stored: string): Promise<string> {
	if (!isEncryptedWebhookSecret(stored)) return stored;
	const current = currentKey(env);
	const previous = previousKeys(env);
	if (!current && previous.length === 0) {
		throw new Error("A webhook encryption key is required to deliver encrypted webhooks");
	}

	if (stored.startsWith(PREFIX)) {
		const parts = stored.slice(PREFIX.length).split(":");
		if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("Malformed encrypted webhook secret");
		const [keyId, ivEncoded, ciphertextEncoded] = parts;
		const spec = [current, ...previous].find((candidate) => candidate?.id === keyId);
		if (!spec) throw new Error(`Webhook encryption key '${keyId}' is not configured`);
		return decryptV2(spec, ivEncoded, ciphertextEncoded);
	}

	const parts = stored.slice(LEGACY_PREFIX.length).split(":");
	if (parts.length !== 2 || parts.some((part) => !part)) throw new Error("Malformed encrypted webhook secret");
	return decryptLegacy([current, ...previous].filter((spec): spec is KeySpec => Boolean(spec)), parts[0], parts[1]);
}

/** Re-encrypt plaintext, V1, or an older V2 secret with the active key. */
export async function rotateWebhookSecret(env: Bindings, stored: string): Promise<string> {
	const current = currentKey(env);
	if (!current || stored.startsWith(`${PREFIX}${current.id}:`)) return stored;
	const plaintext = isEncryptedWebhookSecret(stored) ? await decryptWebhookSecret(env, stored) : stored;
	return encryptWithCurrentKey(current, plaintext);
}

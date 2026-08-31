// WebAuthn helpers for P256 passkey creation and signing

import i18n from "./i18n";
import { readMigratedStorage, writeStorage } from "./storageMigration";

const PASSKEY_STORAGE_KEY = "gatopago:remembered-passkeys:v1";
const LEGACY_PASSKEY_STORAGE_KEY = "parmelia:remembered-passkeys:v1";

export type RememberedPasskey = {
	credentialId: string;
	qx: string;
	qy: string;
	rpId?: string;
	createdAt: string;
	lastUsedAt: string;
};

export type PasskeyCreationMode = "device" | "security-key";

export type PasskeyRegistrationChallenge = {
	registrationId: string;
	challenge: string;
	rpId: string;
	excludeCredentials?: Array<{ id: string; transports?: string[] }>;
	name?: string;
};

export type PasskeyAuthenticationChallenge = {
	authenticationId: string;
	challenge: string;
	rpId: string;
	allowCredentials: Array<{ id: string; transports?: string[] }>;
};

export class PasskeyAlreadyOnAuthenticatorError extends Error {
	constructor() {
		super(i18n.t("webauthn.alreadyOnAuthenticator"));
		this.name = "PasskeyAlreadyOnAuthenticatorError";
	}
}

function bufferToBase64url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let str = "";
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBuffer(base64url: string): ArrayBuffer {
	const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function assertRpIdForCurrentOrigin(value: string): string {
	const rpId = value.trim().toLowerCase();
	const currentHost = window.location.hostname.toLowerCase();
	const localDevelopmentHost =
		currentHost === "localhost" ||
		currentHost.endsWith(".localhost") ||
		/^127(?:\.\d{1,3}){3}$/u.test(currentHost);
	if (
		!rpId ||
		(currentHost !== rpId && !currentHost.endsWith(`.${rpId}`)) ||
		(window.location.protocol !== "https:" && !localDevelopmentHost)
	) {
		throw new Error(i18n.t("webauthn.invalidRpId"));
	}
	return rpId;
}

function canUseLocalStorage() {
	return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function readRememberedPasskeys(): Record<string, RememberedPasskey> {
	if (!canUseLocalStorage()) return {};

	try {
		const raw = readMigratedStorage(PASSKEY_STORAGE_KEY, LEGACY_PASSKEY_STORAGE_KEY);
		if (!raw) return {};

		const parsed = JSON.parse(raw) as Record<string, RememberedPasskey>;
		if (!parsed || typeof parsed !== "object") return {};
		return parsed;
	} catch {
		return {};
	}
}

function writeRememberedPasskeys(passkeys: Record<string, RememberedPasskey>) {
	if (!canUseLocalStorage()) return;
	writeStorage(PASSKEY_STORAGE_KEY, JSON.stringify(passkeys));
}

/**
 * Local hint only. A passkey synchronized by Google Password Manager or iCloud
 * may be usable even when this browser has no GatoPago metadata for it.
 */
export function hasRememberedPasskeyHint(credentialId?: string | null): boolean {
	const remembered = readRememberedPasskeys();
	if (credentialId) return Boolean(remembered[credentialId]);
	return Object.keys(remembered).length > 0;
}

export function rememberPasskey(passkey: { credentialId: string; qx: string; qy: string; rpId?: string }) {
	const remembered = readRememberedPasskeys();
	const existing = remembered[passkey.credentialId];
	const now = new Date().toISOString();

	remembered[passkey.credentialId] = {
		credentialId: passkey.credentialId,
		qx: passkey.qx,
		qy: passkey.qy,
		...(passkey.rpId ? { rpId: passkey.rpId } : {}),
		createdAt: existing?.createdAt || now,
		lastUsedAt: now,
	};

	writeRememberedPasskeys(remembered);
	return remembered[passkey.credentialId];
}

function markPasskeyUsed(credentialId: string) {
	const remembered = readRememberedPasskeys();
	const entry = remembered[credentialId];
	if (!entry) return;

	remembered[credentialId] = {
		...entry,
		lastUsedAt: new Date().toISOString(),
	};
	writeRememberedPasskeys(remembered);
}

function resolveRememberedPasskey(
	usedCredentialId: string,
	hintedCredentialId?: string | null,
) {
	const remembered = readRememberedPasskeys();

	if (remembered[usedCredentialId]) {
		return remembered[usedCredentialId];
	}

	if (hintedCredentialId && remembered[hintedCredentialId]) {
		return remembered[hintedCredentialId];
	}

	const all = Object.values(remembered);
	if (all.length === 1) {
		return all[0];
	}

	return null;
}

/**
 * Create a new P256 passkey. Returns the credentialId and public key (qx, qy).
 * `userId` must be the stable Firebase uid (it keys the resident credential on
 * the device); `label` is what the OS passkey dialog shows - pass something
 * human like the user's email, never the uid.
 */
export async function createPasskey(
	userId: string,
	label?: string,
	registration?: PasskeyRegistrationChallenge,
	mode: PasskeyCreationMode = "device",
): Promise<{
	registrationId: string;
	credentialId: string;
	qx: string;
	qy: string;
	clientDataJSON: string;
	attestationObject: string;
	clientExtensionResults: AuthenticationExtensionsClientOutputs;
	authenticatorAttachment?: AuthenticatorAttachment;
	transports: string[];
	rpId: string;
	creationMode: PasskeyCreationMode;
	name?: string;
}> {
	if (!registration?.registrationId || !registration.challenge || !registration.rpId) {
		throw new Error(i18n.t("webauthn.registrationExpired"));
	}
	const challenge = new Uint8Array(base64urlToBuffer(registration.challenge));
	const rpId = assertRpIdForCurrentOrigin(registration.rpId);
	const displayLabel = label?.trim() || i18n.t("webauthn.accountLabel");
	const transportValues = new Set<AuthenticatorTransport>([
		"ble",
		"hybrid",
		"internal",
		"nfc",
		"usb",
	]);
	const excludeCredentials = (registration.excludeCredentials ?? [])
		.filter((entry) => Boolean(entry.id))
		.map((entry): PublicKeyCredentialDescriptor => ({
			id: base64urlToBuffer(entry.id),
			type: "public-key",
			transports: entry.transports
				?.filter((transport): transport is AuthenticatorTransport =>
					transportValues.has(transport as AuthenticatorTransport),
				),
		}));
	const publicKey: PublicKeyCredentialCreationOptions & { hints?: string[] } = {
		rp: { name: "GatoPago", id: rpId },
		user: {
			id: new TextEncoder().encode(userId),
			name: displayLabel,
			displayName: displayLabel,
		},
		challenge,
		pubKeyCredParams: [{ alg: -7, type: "public-key" }],
		authenticatorSelection: {
			authenticatorAttachment: mode === "security-key" ? "cross-platform" : "platform",
			residentKey: "required",
			userVerification: "required",
		},
		attestation: "none",
		timeout: 60000,
		...(excludeCredentials.length > 0 ? { excludeCredentials } : {}),
		hints: [mode === "security-key" ? "security-key" : "client-device"],
	};

	let credential: PublicKeyCredential | null;
	try {
		credential = (await navigator.credentials.create({
			publicKey,
		})) as PublicKeyCredential | null;
	} catch (error) {
		if (error instanceof DOMException && error.name === "InvalidStateError") {
			// WebAuthn returns InvalidStateError when this authenticator already
			// contains one of the account credentials in excludeCredentials. That is
			// a safe duplicate-prevention result, not an internal application error.
			throw new PasskeyAlreadyOnAuthenticatorError();
		}
		throw error;
	}

	if (!credential) throw new Error(i18n.t("webauthn.createError"));

	const attestation = credential.response as AuthenticatorAttestationResponse;
	const { qx, qy } = extractP256PublicKey(attestation);
	const authenticatorAttachment =
		credential.authenticatorAttachment === "platform" ||
		credential.authenticatorAttachment === "cross-platform"
			? credential.authenticatorAttachment
			: undefined;
	return {
		registrationId: registration.registrationId,
		credentialId: bufferToBase64url(credential.rawId),
		qx: "0x" + qx,
		qy: "0x" + qy,
		clientDataJSON: bufferToBase64url(attestation.clientDataJSON),
		attestationObject: bufferToBase64url(attestation.attestationObject),
		clientExtensionResults: credential.getClientExtensionResults(),
		...(authenticatorAttachment
			? { authenticatorAttachment }
			: {}),
		transports: typeof attestation.getTransports === "function"
			? attestation.getTransports()
			: [],
		rpId,
		creationMode: mode,
		...(registration.name ? { name: registration.name } : {}),
	};
}

/**
 * Ask the current browser/passkey manager to prove it can use one of the
 * account's active credentials. The Worker verifies the returned assertion;
 * this is deliberately separate from local remembered metadata.
 */
export async function createPasskeyAvailabilityAssertion(
	authentication: PasskeyAuthenticationChallenge,
): Promise<{
	authenticationId: string;
	id: string;
	rawId: string;
	type: "public-key";
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle?: string;
	};
	clientExtensionResults: AuthenticationExtensionsClientOutputs;
	authenticatorAttachment?: AuthenticatorAttachment;
}> {
	if (
		!authentication.authenticationId ||
		!authentication.challenge ||
		!authentication.rpId ||
		authentication.allowCredentials.length === 0
	) {
		throw new Error(i18n.t("webauthn.authenticationExpired"));
	}
	const transportValues = new Set<AuthenticatorTransport>([
		"ble",
		"hybrid",
		"internal",
		"nfc",
		"usb",
	]);
	const credential = await navigator.credentials.get({
		publicKey: {
			challenge: base64urlToBuffer(authentication.challenge),
			rpId: assertRpIdForCurrentOrigin(authentication.rpId),
			allowCredentials: authentication.allowCredentials.map((entry) => ({
				id: base64urlToBuffer(entry.id),
				type: "public-key" as const,
				transports: entry.transports
					?.filter((transport): transport is AuthenticatorTransport =>
						transportValues.has(transport as AuthenticatorTransport),
					),
			})),
			userVerification: "required",
			timeout: 60_000,
		},
	}) as PublicKeyCredential | null;
	if (!credential) throw new Error(i18n.t("webauthn.cancelled"));

	const response = credential.response as AuthenticatorAssertionResponse;
	const attachment = credential.authenticatorAttachment === "platform" ||
		credential.authenticatorAttachment === "cross-platform"
		? credential.authenticatorAttachment
		: undefined;
	return {
		authenticationId: authentication.authenticationId,
		id: bufferToBase64url(credential.rawId),
		rawId: bufferToBase64url(credential.rawId),
		type: "public-key",
		response: {
			clientDataJSON: bufferToBase64url(response.clientDataJSON),
			authenticatorData: bufferToBase64url(response.authenticatorData),
			signature: bufferToBase64url(response.signature),
			...(response.userHandle
				? { userHandle: bufferToBase64url(response.userHandle) }
				: {}),
		},
		clientExtensionResults: credential.getClientExtensionResults(),
		...(attachment ? { authenticatorAttachment: attachment } : {}),
	};
}

/** Extract P256 public key (qx, qy) from AuthenticatorAttestationResponse */
function extractP256PublicKey(attestation: AuthenticatorAttestationResponse): { qx: string; qy: string } {
	const spkiDer = attestation.getPublicKey();
	if (!spkiDer) throw new Error(i18n.t("webauthn.publicKeyError"));

	const spki = new Uint8Array(spkiDer);
	const uncompressedOffset = spki.length - 65;
	if (spki[uncompressedOffset] !== 0x04) {
		throw new Error(i18n.t("webauthn.publicKeyFormatError"));
	}
	const x = spki.slice(uncompressedOffset + 1, uncompressedOffset + 33);
	const y = spki.slice(uncompressedOffset + 33, uncompressedOffset + 65);
	return { qx: bytesToHex(x), qy: bytesToHex(y) };
}

async function requestAssertion(
	challenge: Uint8Array,
	rpId: string,
	credentialId?: string | null,
): Promise<PublicKeyCredential | null> {
	const publicKey: PublicKeyCredentialRequestOptions = {
		challenge: challenge.buffer as ArrayBuffer,
		rpId: assertRpIdForCurrentOrigin(rpId),
		userVerification: "required",
		timeout: 60000,
	};

	if (credentialId) {
		publicKey.allowCredentials = [
			{
				id: base64urlToBuffer(credentialId),
				type: "public-key",
			},
		];
	}

	return (await navigator.credentials.get({
		publicKey,
	})) as PublicKeyCredential | null;
}

/**
 * Sign a challenge (userOpHash) with a passkey.
 *
 * If we have a stored credentialId, use it first so the browser does not offer
 * unrelated synced passkeys from the same RP. Discoverable credentials are kept
 * only for accounts that do not have a stored hint yet.
 */
export async function signWithPasskey(
	challenge: Uint8Array,
	credentialId: string | null | undefined,
	rpId: string,
): Promise<{
	authenticatorData: string;
	clientDataJSON: string;
	r: string;
	s: string;
	credentialId: string;
	qx: string | null;
	qy: string | null;
}> {
	let assertion: PublicKeyCredential | null = null;
	let requestError: unknown = null;

	const attempts = credentialId
		? [
			() => requestAssertion(challenge, rpId, credentialId),
			() => requestAssertion(challenge, rpId),
		]
		: [() => requestAssertion(challenge, rpId)];

	for (const attempt of attempts) {
		try {
			assertion = await attempt();
			if (assertion) break;
		} catch (error) {
			// A dismissed/blocked prompt (NotAllowedError/AbortError) must NOT chain
			// straight into a second prompt - propagate so the UI shows the calm
			// "cancelled" notice and the user retries explicitly.
			if (
				error instanceof DOMException &&
				(error.name === "NotAllowedError" || error.name === "AbortError")
			) {
				throw error;
			}
			requestError = error;
		}
	}

	if (!assertion) {
		if (requestError instanceof Error) {
			throw requestError;
		}
		throw new Error(i18n.t("webauthn.cancelled"));
	}

	const response = assertion.response as AuthenticatorAssertionResponse;
	const authenticatorData = new Uint8Array(response.authenticatorData);
	const clientDataJSON = new TextDecoder().decode(response.clientDataJSON);
	const signature = new Uint8Array(response.signature);
	const { r, s } = parseDERSignature(signature);
	const assertionCredentialId = bufferToBase64url(assertion.rawId);
	const rememberedPasskey = resolveRememberedPasskey(assertionCredentialId, credentialId);

	if (rememberedPasskey) {
		markPasskeyUsed(rememberedPasskey.credentialId);
	}

	return {
		authenticatorData: "0x" + bytesToHex(authenticatorData),
		clientDataJSON,
		r: "0x" + r.padStart(64, "0"),
		s: "0x" + s.padStart(64, "0"),
		credentialId: assertionCredentialId,
		qx: rememberedPasskey?.qx ?? null,
		qy: rememberedPasskey?.qy ?? null,
	};
}

/** Parse a DER-encoded ECDSA signature into r and s hex strings */
function parseDERSignature(der: Uint8Array): { r: string; s: string } {
	if (der[0] !== 0x30) throw new Error("Invalid DER signature");
	let offset = 2;

	if (der[offset] !== 0x02) throw new Error("Invalid DER r tag");
	offset++;
	const rLen = der[offset];
	offset++;
	let rBytes = der.slice(offset, offset + rLen);
	offset += rLen;
	if (rBytes[0] === 0x00 && rBytes.length > 32) rBytes = rBytes.slice(1);
	const r = bytesToHex(rBytes);

	if (der[offset] !== 0x02) throw new Error("Invalid DER s tag");
	offset++;
	const sLen = der[offset];
	offset++;
	let sBytes = der.slice(offset, offset + sLen);
	if (sBytes[0] === 0x00 && sBytes.length > 32) sBytes = sBytes.slice(1);
	const s = bytesToHex(sBytes);

	return { r, s };
}

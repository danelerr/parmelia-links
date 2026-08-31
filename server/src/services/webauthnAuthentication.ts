import {
	type AuthenticationResponseJSON,
	type AuthenticatorTransportFuture,
	verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import type { Bindings } from "../env";
import type { PasskeyRecord } from "./storage/passkeys";
import { getPasskey } from "./storage/passkeys";

const AUTHENTICATION_TTL_SECONDS = 2 * 60;
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{8,1024}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const MAX_ASSERTION_PART_LENGTH = 16 * 1024;

type AuthenticationRow = {
	id: string;
	uid: string;
	challenge: string;
	expected_origin: string;
	expected_rp_id: string;
	consumed_at: string | null;
	expires_at: string;
};

export type WebAuthnAuthenticationCredential = {
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
	clientExtensionResults?: Record<string, unknown>;
	authenticatorAttachment?: "platform" | "cross-platform";
};

export class InvalidWebAuthnAuthenticationError extends Error {
	constructor(message = "WebAuthn authentication is invalid or expired") {
		super(message);
		this.name = "InvalidWebAuthnAuthenticationError";
	}
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function hexCoordinate(value: string): Uint8Array {
	const normalized = value.replace(/^0x/u, "");
	if (!/^[0-9a-fA-F]{64}$/u.test(normalized)) {
		throw new InvalidWebAuthnAuthenticationError();
	}
	return Uint8Array.from(
		normalized.match(/.{2}/gu) ?? [],
		(pair) => Number.parseInt(pair, 16),
	);
}

/**
 * Reconstruct the canonical COSE EC2/ES256 key from the P-256 coordinates
 * already used by the account contract.
 */
function cosePublicKey(passkey: PasskeyRecord): Uint8Array<ArrayBuffer> {
	const x = hexCoordinate(passkey.qx);
	const y = hexCoordinate(passkey.qy);
	// A5 { 1:2(kty EC2), 3:-7(ES256), -1:1(P-256), -2:bstr(x), -3:bstr(y) }
	const encoded = [
		0xa5,
		0x01, 0x02,
		0x03, 0x26,
		0x20, 0x01,
		0x21, 0x58, 0x20, ...x,
		0x22, 0x58, 0x20, ...y,
	];
	const result = new Uint8Array(encoded.length);
	result.set(encoded);
	return result;
}

function normalizedTransports(values: readonly string[]): AuthenticatorTransportFuture[] {
	const accepted = new Set<AuthenticatorTransportFuture>([
		"ble",
		"cable",
		"hybrid",
		"internal",
		"nfc",
		"smart-card",
		"usb",
	]);
	return values.filter(
		(value): value is AuthenticatorTransportFuture =>
			accepted.has(value as AuthenticatorTransportFuture),
	);
}

export async function issueWebAuthnAuthentication(
	env: Bindings,
	input: {
		uid: string;
		expectedOrigin: string;
		expectedRpId: string;
		activePasskeys: readonly PasskeyRecord[];
	},
) {
	if (input.activePasskeys.length === 0) {
		throw new InvalidWebAuthnAuthenticationError("No active passkeys are registered");
	}
	const id = crypto.randomUUID();
	const challengeBytes = new Uint8Array(32);
	crypto.getRandomValues(challengeBytes);
	const challenge = base64url(challengeBytes);
	const createdAt = new Date();
	const expiresAt = new Date(createdAt.getTime() + AUTHENTICATION_TTL_SECONDS * 1000);

	const result = await env.GATOPAGO_DB.prepare(
		`INSERT INTO webauthn_authentication_challenges (
			id, uid, challenge, expected_origin, expected_rp_id,
			consumed_at, expires_at, created_at
		 ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
	).bind(
		id,
		input.uid,
		challenge,
		input.expectedOrigin,
		input.expectedRpId,
		expiresAt.toISOString(),
		createdAt.toISOString(),
	).run();
	if (!result.success || result.meta.changes !== 1) {
		throw new Error("Could not persist WebAuthn authentication challenge");
	}

	return {
		authenticationId: id,
		challenge,
		rpId: input.expectedRpId,
		allowCredentials: input.activePasskeys.map((passkey) => ({
			id: passkey.credentialId,
			transports: normalizedTransports(passkey.transports),
		})),
	};
}

function validBase64urlPart(value: string): boolean {
	return value.length > 0 && value.length <= MAX_ASSERTION_PART_LENGTH && BASE64URL_RE.test(value);
}

export async function verifyWebAuthnAuthentication(
	env: Bindings,
	input: {
		uid: string;
		credential: WebAuthnAuthenticationCredential;
	},
): Promise<{ passkey: PasskeyRecord; newCounter: number }> {
	const credential = input.credential;
	if (
		!credential.authenticationId ||
		!CREDENTIAL_ID_RE.test(credential.id) ||
		credential.rawId !== credential.id ||
		credential.type !== "public-key" ||
		!validBase64urlPart(credential.response.clientDataJSON) ||
		!validBase64urlPart(credential.response.authenticatorData) ||
		!validBase64urlPart(credential.response.signature) ||
		(credential.response.userHandle !== undefined &&
			!validBase64urlPart(credential.response.userHandle))
	) {
		throw new InvalidWebAuthnAuthenticationError();
	}

	const row = await env.GATOPAGO_DB.prepare(
		`SELECT id, uid, challenge, expected_origin, expected_rp_id,
		        consumed_at, expires_at
		 FROM webauthn_authentication_challenges
		 WHERE id = ? AND uid = ? LIMIT 1`,
	).bind(credential.authenticationId, input.uid).first<AuthenticationRow>();
	if (!row || row.consumed_at || Date.parse(row.expires_at) <= Date.now()) {
		throw new InvalidWebAuthnAuthenticationError();
	}

	// Claim before expensive verification. Exactly one request can consume this
	// challenge, including when two tabs submit the same assertion concurrently.
	const consumedAt = new Date().toISOString();
	const claimed = await env.GATOPAGO_DB.prepare(
		`UPDATE webauthn_authentication_challenges SET consumed_at = ?
		 WHERE id = ? AND uid = ? AND consumed_at IS NULL AND expires_at > ?`,
	).bind(consumedAt, row.id, input.uid, consumedAt).run();
	if (!claimed.success || claimed.meta.changes !== 1) {
		throw new InvalidWebAuthnAuthenticationError();
	}

	const passkey = await getPasskey(env, credential.id);
	if (
		!passkey ||
		passkey.uid !== input.uid ||
		(passkey.rpId !== null && passkey.rpId !== row.expected_rp_id)
	) {
		throw new InvalidWebAuthnAuthenticationError();
	}

	try {
		const response: AuthenticationResponseJSON = {
			id: credential.id,
			rawId: credential.rawId,
			type: "public-key",
			response: {
				clientDataJSON: credential.response.clientDataJSON,
				authenticatorData: credential.response.authenticatorData,
				signature: credential.response.signature,
				...(credential.response.userHandle
					? { userHandle: credential.response.userHandle }
					: {}),
			},
			clientExtensionResults: credential.clientExtensionResults ?? {},
			...(credential.authenticatorAttachment
				? { authenticatorAttachment: credential.authenticatorAttachment }
				: {}),
		};
		const verification = await verifyAuthenticationResponse({
			response,
			expectedChallenge: row.challenge,
			expectedOrigin: row.expected_origin,
			expectedRPID: row.expected_rp_id,
			credential: {
				id: passkey.credentialId,
				publicKey: cosePublicKey(passkey),
				counter: passkey.signCount,
				transports: normalizedTransports(passkey.transports),
			},
			requireUserVerification: true,
		});
		if (!verification.verified || !verification.authenticationInfo.userVerified) {
			throw new InvalidWebAuthnAuthenticationError();
		}
		return {
			passkey,
			newCounter: verification.authenticationInfo.newCounter,
		};
	} catch (error) {
		if (error instanceof InvalidWebAuthnAuthenticationError) throw error;
		throw new InvalidWebAuthnAuthenticationError();
	}
}

export async function deleteExpiredWebAuthnAuthentications(env: Bindings): Promise<void> {
	await env.GATOPAGO_DB.prepare(
		"DELETE FROM webauthn_authentication_challenges WHERE expires_at < ?",
	).bind(new Date().toISOString()).run();
}

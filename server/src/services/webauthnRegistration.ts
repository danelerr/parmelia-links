import {
	type AuthenticatorTransportFuture,
	type RegistrationResponseJSON,
	verifyRegistrationResponse,
} from "@simplewebauthn/server";
import {
	cose,
	decodeCredentialPublicKey,
} from "@simplewebauthn/server/helpers";
import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../env";

const REGISTRATION_TTL_SECONDS = 5 * 60;
const CREDENTIAL_ID_RE = /^[A-Za-z0-9_-]{8,1024}$/;
const COORDINATE_RE = /^0x[0-9a-fA-F]{64}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const CLIENT_DATA_MAX_LENGTH = 8_192;
const ATTESTATION_OBJECT_MAX_LENGTH = 64 * 1_024;
const MAX_VERIFICATION_ATTEMPTS = 5;

export type WebAuthnRegistrationPurpose =
	| "account_create"
	| "passkey_add"
	| "recovery_propose";

type RegistrationRow = {
	id: string;
	uid: string;
	purpose: WebAuthnRegistrationPurpose;
	challenge: string;
	expected_origin: string;
	credential_id: string | null;
	qx: string | null;
	qy: string | null;
	name: string | null;
	transports_json: string | null;
	claim_id: string | null;
	verification_attempts: number;
	finalized_at: string | null;
	expires_at: string;
	consumed_at: string | null;
};

export type WebAuthnRegistrationCredential = {
	registrationId: string;
	credentialId: string;
	qx: string;
	qy: string;
	clientDataJSON: string;
	attestationObject: string;
	clientExtensionResults?: Record<string, unknown>;
	authenticatorAttachment?: "platform" | "cross-platform";
	transports?: string[];
	name?: string;
};

export type FinalizedWebAuthnRegistration = {
	registrationId: string;
	credentialId: string;
	qx: string;
	qy: string;
	name: string | null;
	transports: string[];
};

export class InvalidWebAuthnRegistrationError extends Error {
	constructor(message = "WebAuthn registration is invalid or expired") {
		super(message);
		this.name = "InvalidWebAuthnRegistrationError";
	}
}

function base64url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function allowedOrigins(env: Bindings): string[] {
	return env.ALLOWED_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
}

/** Resolve the browser origin that a registration challenge may be bound to. */
export function validWebAuthnRegistrationOrigin(
	env: Bindings,
	requestOrigin: string | undefined,
): string | null {
	if (!requestOrigin) return null;
	let normalized: string;
	try {
		const parsed = new URL(requestOrigin);
		if (parsed.origin !== requestOrigin || !["https:", "http:"].includes(parsed.protocol)) return null;
		normalized = parsed.origin;
	} catch {
		return null;
	}

	const configured = allowedOrigins(env);
	if (configured.length > 0) return configured.includes(normalized) ? normalized : null;

	// An open origin is a local/testnet convenience only. Runtime configuration
	// already requires an exact HTTPS allowlist before mainnet traffic is served.
	const network = getNetworkConfig(env.CHAIN_KEY);
	return network.isTestnet ? normalized : null;
}

export async function issueWebAuthnRegistration(
	env: Bindings,
	input: {
		uid: string;
		purpose: WebAuthnRegistrationPurpose;
		expectedOrigin: string;
	},
): Promise<{ registrationId: string; challenge: string; expiresInSeconds: number }> {
	const id = crypto.randomUUID();
	const challengeBytes = crypto.getRandomValues(new Uint8Array(32));
	const challenge = base64url(challengeBytes);
	const now = new Date();
	const createdAt = now.toISOString();
	const expiresAt = new Date(now.getTime() + REGISTRATION_TTL_SECONDS * 1_000).toISOString();

	await env.GATOPAGO_DB.batch([
		env.GATOPAGO_DB.prepare(
			`UPDATE webauthn_registration_challenges
			 SET consumed_at = ?
			 WHERE uid = ? AND purpose = ? AND consumed_at IS NULL`,
		).bind(createdAt, input.uid, input.purpose),
		env.GATOPAGO_DB.prepare(
			`INSERT INTO webauthn_registration_challenges (
				id, uid, purpose, challenge, expected_origin, expires_at, created_at
			 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			id,
			input.uid,
			input.purpose,
			challenge,
			input.expectedOrigin,
			expiresAt,
			createdAt,
		),
	]);

	return { registrationId: id, challenge, expiresInSeconds: REGISTRATION_TTL_SECONDS };
}

function bytesToHex(bytes: Uint8Array): string {
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function validEncodedResponse(credential: WebAuthnRegistrationCredential): boolean {
	return (
		credential.clientDataJSON.length > 0 &&
		credential.clientDataJSON.length <= CLIENT_DATA_MAX_LENGTH &&
		BASE64URL_RE.test(credential.clientDataJSON) &&
		credential.attestationObject.length > 0 &&
		credential.attestationObject.length <= ATTESTATION_OBJECT_MAX_LENGTH &&
		BASE64URL_RE.test(credential.attestationObject) &&
		(!credential.authenticatorAttachment ||
			credential.authenticatorAttachment === "platform" ||
			credential.authenticatorAttachment === "cross-platform") &&
		(!credential.clientExtensionResults ||
			(typeof credential.clientExtensionResults === "object" &&
				!Array.isArray(credential.clientExtensionResults)))
	);
}

async function verifyCredentialResponse(
	row: RegistrationRow,
	credential: WebAuthnRegistrationCredential,
): Promise<{ qx: string; qy: string }> {
	if (!validEncodedResponse(credential)) throw new InvalidWebAuthnRegistrationError();
	let rpId: string;
	try {
		rpId = new URL(row.expected_origin).hostname;
	} catch {
		throw new InvalidWebAuthnRegistrationError();
	}

	try {
		const response: RegistrationResponseJSON = {
			id: credential.credentialId,
			rawId: credential.credentialId,
			type: "public-key",
			response: {
				clientDataJSON: credential.clientDataJSON,
				attestationObject: credential.attestationObject,
				transports: normalizedTransports(credential.transports),
			},
			clientExtensionResults: credential.clientExtensionResults ?? {},
			...(credential.authenticatorAttachment
				? { authenticatorAttachment: credential.authenticatorAttachment }
				: {}),
		};
		const verification = await verifyRegistrationResponse({
			response,
			expectedChallenge: row.challenge,
			expectedOrigin: row.expected_origin,
			expectedRPID: rpId,
			requireUserPresence: true,
			requireUserVerification: true,
			supportedAlgorithmIDs: [-7],
		});
		if (!verification.verified || verification.registrationInfo.fmt !== "none") {
			throw new InvalidWebAuthnRegistrationError();
		}
		const verifiedCredential = verification.registrationInfo.credential;
		if (verifiedCredential.id !== credential.credentialId) {
			throw new InvalidWebAuthnRegistrationError();
		}
		const publicKey = decodeCredentialPublicKey(verifiedCredential.publicKey);
		if (
			!cose.isCOSEPublicKeyEC2(publicKey) ||
			publicKey.get(cose.COSEKEYS.kty) !== cose.COSEKTY.EC2 ||
			publicKey.get(cose.COSEKEYS.alg) !== cose.COSEALG.ES256 ||
			publicKey.get(cose.COSEKEYS.crv) !== cose.COSECRV.P256
		) {
			throw new InvalidWebAuthnRegistrationError();
		}
		const x = publicKey.get(cose.COSEKEYS.x);
		const y = publicKey.get(cose.COSEKEYS.y);
		if (!x || !y || x.length !== 32 || y.length !== 32) {
			throw new InvalidWebAuthnRegistrationError();
		}
		const qx = `0x${bytesToHex(x)}`;
		const qy = `0x${bytesToHex(y)}`;
		if (
			qx !== credential.qx.toLowerCase() ||
			qy !== credential.qy.toLowerCase()
		) {
			throw new InvalidWebAuthnRegistrationError();
		}
		return { qx, qy };
	} catch (error) {
		if (error instanceof InvalidWebAuthnRegistrationError) throw error;
		throw new InvalidWebAuthnRegistrationError();
	}
}

async function claimWebAuthnRegistration(
	env: Bindings,
	input: {
		uid: string;
		purpose: WebAuthnRegistrationPurpose;
		credential: WebAuthnRegistrationCredential;
	},
): Promise<{ registrationId: string; claimId: string; row: RegistrationRow }> {
	const { credential } = input;
	if (
		!credential.registrationId ||
		!CREDENTIAL_ID_RE.test(credential.credentialId) ||
		!COORDINATE_RE.test(credential.qx) ||
		!COORDINATE_RE.test(credential.qy) ||
		!validEncodedResponse(credential)
	) {
		throw new InvalidWebAuthnRegistrationError();
	}

	const now = new Date().toISOString();
	const row = await env.GATOPAGO_DB.prepare(
		`SELECT id, uid, purpose, challenge, expected_origin,
		        credential_id, qx, qy, name, transports_json,
		        claim_id, verification_attempts, finalized_at, expires_at, consumed_at
		 FROM webauthn_registration_challenges
		 WHERE id = ? AND uid = ? AND purpose = ?
		 LIMIT 1`,
	).bind(credential.registrationId, input.uid, input.purpose).first<RegistrationRow>();
	if (
		!row ||
		row.consumed_at ||
		row.claim_id ||
		row.expires_at <= now ||
		row.verification_attempts >= MAX_VERIFICATION_ATTEMPTS
	) {
		throw new InvalidWebAuthnRegistrationError();
	}

	const claimId = crypto.randomUUID();
	const claimed = await env.GATOPAGO_DB.prepare(
		`UPDATE webauthn_registration_challenges
		 SET claim_id = ?, claimed_at = ?,
		     verification_attempts = verification_attempts + 1
		 WHERE id = ? AND uid = ? AND purpose = ?
		   AND claim_id IS NULL AND consumed_at IS NULL AND expires_at > ?
		   AND verification_attempts < ?`,
	).bind(
		claimId,
		now,
		row.id,
		input.uid,
		input.purpose,
		now,
		MAX_VERIFICATION_ATTEMPTS,
	).run();
	if (!claimed.success || claimed.meta.changes !== 1) {
		throw new InvalidWebAuthnRegistrationError();
	}
	return { registrationId: row.id, claimId, row };
}

function normalizedName(value: string | undefined): string | null {
	const name = value?.trim();
	return name ? name.slice(0, 64) : null;
}

function normalizedTransports(value: string[] | undefined): AuthenticatorTransportFuture[] {
	const allowed = new Set<AuthenticatorTransportFuture>([
		"ble",
		"cable",
		"hybrid",
		"internal",
		"nfc",
		"smart-card",
		"usb",
	]);
	return [...new Set((value ?? []).filter(
		(entry): entry is AuthenticatorTransportFuture =>
			allowed.has(entry as AuthenticatorTransportFuture),
	))].slice(0, 8);
}

function finalizedFromRow(row: RegistrationRow): FinalizedWebAuthnRegistration | null {
	if (!row.credential_id || !row.qx || !row.qy || !row.finalized_at || !row.consumed_at) return null;
	let transports: string[] = [];
	try {
		const parsed = JSON.parse(row.transports_json ?? "[]") as unknown;
		if (Array.isArray(parsed)) transports = normalizedTransports(parsed.filter((item): item is string => typeof item === "string"));
	} catch {
		transports = [];
	}
	return {
		registrationId: row.id,
		credentialId: row.credential_id,
		qx: row.qx,
		qy: row.qy,
		name: row.name,
		transports,
	};
}

async function readRegistration(
	env: Bindings,
	input: { registrationId: string; uid: string; purpose: WebAuthnRegistrationPurpose },
): Promise<RegistrationRow | null> {
	return env.GATOPAGO_DB.prepare(
		`SELECT id, uid, purpose, challenge, expected_origin,
		        credential_id, qx, qy, name, transports_json,
		        claim_id, verification_attempts, finalized_at, expires_at, consumed_at
		 FROM webauthn_registration_challenges
		 WHERE id = ? AND uid = ? AND purpose = ?
		 LIMIT 1`,
	).bind(input.registrationId, input.uid, input.purpose).first<RegistrationRow>();
}

/**
 * Bind the browser-created credential to its one-time server challenge. The
 * completed row is durable and idempotent so a transient RPC failure can retry
 * the account action without asking the OS to create another passkey.
 */
export async function finalizeWebAuthnRegistration(
	env: Bindings,
	input: {
		uid: string;
		purpose: WebAuthnRegistrationPurpose;
		credential: WebAuthnRegistrationCredential;
	},
): Promise<FinalizedWebAuthnRegistration> {
	const existing = await readRegistration(env, {
		registrationId: input.credential.registrationId,
		uid: input.uid,
		purpose: input.purpose,
	});
	const alreadyFinalized = existing ? finalizedFromRow(existing) : null;
	if (alreadyFinalized) {
		const verified = await verifyCredentialResponse(existing!, input.credential);
		if (
			alreadyFinalized.credentialId !== input.credential.credentialId ||
			alreadyFinalized.qx.toLowerCase() !== verified.qx ||
			alreadyFinalized.qy.toLowerCase() !== verified.qy
		) throw new InvalidWebAuthnRegistrationError();
		return alreadyFinalized;
	}

	const claim = await claimWebAuthnRegistration(env, input);
	const finalizedAt = new Date().toISOString();
	const name = normalizedName(input.credential.name);
	const transports = normalizedTransports(input.credential.transports);
	try {
		const verified = await verifyCredentialResponse(claim.row, input.credential);
		const completed = await env.GATOPAGO_DB.prepare(
			`UPDATE webauthn_registration_challenges
			 SET credential_id = ?, qx = ?, qy = ?, name = ?, transports_json = ?,
			     finalized_at = ?, consumed_at = ?
			 WHERE id = ? AND claim_id = ? AND consumed_at IS NULL`,
		).bind(
			input.credential.credentialId,
			verified.qx,
			verified.qy,
			name,
			JSON.stringify(transports),
			finalizedAt,
			finalizedAt,
			claim.registrationId,
			claim.claimId,
		).run();
		if (!completed.success || completed.meta.changes !== 1) {
			throw new InvalidWebAuthnRegistrationError();
		}
		return {
			registrationId: claim.registrationId,
			credentialId: input.credential.credentialId,
			qx: verified.qx,
			qy: verified.qy,
			name,
			transports,
		};
	} catch (error) {
		await releaseWebAuthnRegistration(env, claim).catch(() => undefined);
		throw error;
	}
}

export async function getFinalizedWebAuthnRegistration(
	env: Bindings,
	input: { registrationId: string; uid: string; purpose: WebAuthnRegistrationPurpose },
): Promise<FinalizedWebAuthnRegistration | null> {
	const row = await readRegistration(env, input);
	return row ? finalizedFromRow(row) : null;
}

async function releaseWebAuthnRegistration(
	env: Bindings,
	claim: { registrationId: string; claimId: string },
): Promise<void> {
	await env.GATOPAGO_DB.prepare(
		`UPDATE webauthn_registration_challenges
		 SET claim_id = NULL, claimed_at = NULL
		 WHERE id = ? AND claim_id = ? AND consumed_at IS NULL`,
	).bind(claim.registrationId, claim.claimId).run();
}

export async function deleteExpiredWebAuthnRegistrations(env: Bindings): Promise<void> {
	const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
	await env.GATOPAGO_DB.prepare(
		"DELETE FROM webauthn_registration_challenges WHERE expires_at < ?",
	).bind(cutoff).run();
}

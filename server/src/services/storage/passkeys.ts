import type { Bindings } from "../../middlewares/auth";
import { d1All, d1First, d1Run, didWrite, nowIso } from "./core";

export type PasskeyRecord = {
	credentialId: string;
	uid: string;
	qx: string;
	qy: string;
	name: string | null;
	registrationSource: "onboarding" | "backup" | "recovery" | "observed" | "unknown";
	transports: string[];
	rpId: string | null;
	aaguid: string | null;
	providerName: string | null;
	credentialDeviceType: "singleDevice" | "multiDevice" | null;
	credentialBackedUp: boolean | null;
	authenticatorAttachment: "platform" | "cross-platform" | null;
	metadataUpdatedAt: string | null;
	signCount: number;
	revokedAt: string | null;
	createdAt: string;
	lastUsedAt: string;
};

type PasskeyRow = {
	credential_id: string;
	uid: string;
	qx: string;
	qy: string;
	name: string | null;
	registration_source: PasskeyRecord["registrationSource"];
	transports_json: string | null;
	rp_id: string | null;
	aaguid: string | null;
	provider_name: string | null;
	credential_device_type: PasskeyRecord["credentialDeviceType"];
	credential_backed_up: number | null;
	authenticator_attachment: PasskeyRecord["authenticatorAttachment"];
	metadata_updated_at: string | null;
	sign_count: number;
	revoked_at: string | null;
	created_at: string;
	last_used_at: string;
};

function mapPasskeyRow(row: PasskeyRow): PasskeyRecord {
	let transports: string[] = [];
	try {
		const parsed = JSON.parse(row.transports_json ?? "[]") as unknown;
		if (Array.isArray(parsed)) transports = parsed.filter((item): item is string => typeof item === "string");
	} catch {
		transports = [];
	}
	return {
		credentialId: row.credential_id,
		uid: row.uid,
		qx: row.qx,
		qy: row.qy,
		name: row.name,
		registrationSource: row.registration_source,
		transports,
		rpId: row.rp_id,
		aaguid: row.aaguid,
		providerName: row.provider_name,
		credentialDeviceType: row.credential_device_type,
		credentialBackedUp: row.credential_backed_up === null
			? null
			: row.credential_backed_up === 1,
		authenticatorAttachment: row.authenticator_attachment,
		metadataUpdatedAt: row.metadata_updated_at,
		signCount: row.sign_count,
		revokedAt: row.revoked_at,
		createdAt: row.created_at,
		lastUsedAt: row.last_used_at,
	};
}

/** Upsert a passkey's public key (qx, qy). Refreshes last_used_at on every call. */
export async function savePasskey(
	env: Bindings,
	passkey: {
		credentialId: string;
		uid: string;
		qx: string;
		qy: string;
		name?: string | null;
		registrationSource?: PasskeyRecord["registrationSource"];
		transports?: string[];
		rpId?: string | null;
		aaguid?: string | null;
		providerName?: string | null;
		credentialDeviceType?: PasskeyRecord["credentialDeviceType"];
		credentialBackedUp?: boolean | null;
		authenticatorAttachment?: PasskeyRecord["authenticatorAttachment"];
	},
) {
	const now = nowIso();
	const hasManagementMetadata = Boolean(
		passkey.rpId ||
		passkey.aaguid ||
		passkey.providerName ||
		passkey.credentialDeviceType ||
		(passkey.credentialBackedUp !== undefined && passkey.credentialBackedUp !== null) ||
		passkey.authenticatorAttachment,
	);
	const result = await d1Run(
		env,
		`INSERT INTO passkeys (
			credential_id, uid, qx, qy, name, registration_source,
			transports_json, rp_id, aaguid, provider_name,
			credential_device_type, credential_backed_up,
			authenticator_attachment, metadata_updated_at,
			revoked_at, created_at, last_used_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
		 ON CONFLICT(credential_id) DO UPDATE SET
			qx = excluded.qx,
			qy = excluded.qy,
			name = COALESCE(excluded.name, passkeys.name),
			registration_source = CASE
				WHEN excluded.registration_source = 'unknown' THEN passkeys.registration_source
				ELSE excluded.registration_source
			END,
			transports_json = COALESCE(excluded.transports_json, passkeys.transports_json),
			rp_id = COALESCE(excluded.rp_id, passkeys.rp_id),
			aaguid = COALESCE(excluded.aaguid, passkeys.aaguid),
			provider_name = COALESCE(excluded.provider_name, passkeys.provider_name),
			credential_device_type = COALESCE(excluded.credential_device_type, passkeys.credential_device_type),
			credential_backed_up = COALESCE(excluded.credential_backed_up, passkeys.credential_backed_up),
			authenticator_attachment = COALESCE(excluded.authenticator_attachment, passkeys.authenticator_attachment),
			metadata_updated_at = CASE
				WHEN excluded.rp_id IS NOT NULL
				  OR excluded.aaguid IS NOT NULL
				  OR excluded.credential_device_type IS NOT NULL
				  OR excluded.credential_backed_up IS NOT NULL
				  OR excluded.authenticator_attachment IS NOT NULL
				THEN excluded.metadata_updated_at
				ELSE passkeys.metadata_updated_at
			END,
			revoked_at = NULL,
			last_used_at = excluded.last_used_at
		 WHERE passkeys.uid = excluded.uid`,
		[
			passkey.credentialId,
			passkey.uid,
			passkey.qx.toLowerCase(),
			passkey.qy.toLowerCase(),
			passkey.name?.trim() || null,
			passkey.registrationSource ?? "unknown",
			passkey.transports ? JSON.stringify(passkey.transports) : null,
			passkey.rpId?.trim().toLowerCase() || null,
			passkey.aaguid?.trim().toLowerCase() || null,
			passkey.providerName?.trim() || null,
			passkey.credentialDeviceType ?? null,
			passkey.credentialBackedUp === undefined || passkey.credentialBackedUp === null
				? null
				: passkey.credentialBackedUp ? 1 : 0,
			passkey.authenticatorAttachment ?? null,
			hasManagementMetadata ? now : null,
			now,
			now,
		],
	);
	if (!didWrite(result)) throw new Error("Passkey credential belongs to another user");
}

export async function getPasskey(env: Bindings, credentialId: string): Promise<PasskeyRecord | null> {
	const row = await d1First<PasskeyRow>(
		env,
		`SELECT credential_id, uid, qx, qy, name, registration_source,
		        transports_json, rp_id, aaguid, provider_name,
		        credential_device_type, credential_backed_up,
		        authenticator_attachment, metadata_updated_at, sign_count,
		        revoked_at, created_at, last_used_at
		 FROM passkeys
		 WHERE credential_id = ? AND revoked_at IS NULL
		 LIMIT 1`,
		[credentialId],
	);
	return row ? mapPasskeyRow(row) : null;
}
export async function listPasskeysByUid(env: Bindings, uid: string): Promise<PasskeyRecord[]> {
	const rows = await d1All<PasskeyRow>(
		env,
		`SELECT credential_id, uid, qx, qy, name, registration_source,
		        transports_json, rp_id, aaguid, provider_name,
		        credential_device_type, credential_backed_up,
		        authenticator_attachment, metadata_updated_at, sign_count,
		        revoked_at, created_at, last_used_at
		 FROM passkeys
		 WHERE uid = ? AND revoked_at IS NULL
		 ORDER BY last_used_at DESC, created_at DESC`,
		[uid],
	);
	return rows.map(mapPasskeyRow);
}

export async function renamePasskey(
	env: Bindings,
	input: { uid: string; credentialId: string; name: string },
): Promise<boolean> {
	const result = await d1Run(
		env,
		`UPDATE passkeys SET name = ?
		 WHERE uid = ? AND credential_id = ? AND revoked_at IS NULL`,
		[input.name.trim().slice(0, 64), input.uid, input.credentialId],
	);
	return didWrite(result);
}

export async function markPasskeyRevoked(
	env: Bindings,
	input: { uid: string; credentialId: string; revokedAt?: string },
): Promise<boolean> {
	const result = await d1Run(
		env,
		`UPDATE passkeys SET revoked_at = ?
		 WHERE uid = ? AND credential_id = ? AND revoked_at IS NULL`,
		[input.revokedAt ?? nowIso(), input.uid, input.credentialId],
	);
	return didWrite(result);
}

/**
 * Record a verified WebAuthn assertion and move the non-authoritative signing
 * hint to the credential the user actually selected. This never grants signer
 * authority; the route has already checked the P-256 key against onchain state.
 */
export async function markPasskeyVerified(
	env: Bindings,
	input: { uid: string; credentialId: string; signCount: number },
): Promise<boolean> {
	const now = nowIso();
	const updated = await d1Run(
		env,
		`UPDATE passkeys
		 SET sign_count = MAX(sign_count, ?), last_used_at = ?
		 WHERE uid = ? AND credential_id = ? AND revoked_at IS NULL`,
		[input.signCount, now, input.uid, input.credentialId],
	);
	if (!didWrite(updated)) return false;
	await d1Run(
		env,
		`UPDATE users SET credential_id = ?, updated_at = ? WHERE uid = ?`,
		[input.credentialId, now, input.uid],
	);
	return true;
}

/** Point future signing prompts at a remaining key after a confirmed removal. */
export async function repairPasskeyHintAfterRemoval(
	env: Bindings,
	input: { uid: string; removedCredentialId: string },
): Promise<void> {
	await d1Run(
		env,
		`UPDATE users
		 SET credential_id = (
			SELECT credential_id FROM passkeys
			WHERE uid = ? AND revoked_at IS NULL
			ORDER BY last_used_at DESC, created_at DESC
			LIMIT 1
		 ), updated_at = ?
		 WHERE uid = ? AND credential_id = ?`,
		[input.uid, nowIso(), input.uid, input.removedCredentialId],
	);
}

/** Recovery replaces the complete signer set; mirror that replacement in D1. */
export async function revokePasskeysExcept(
	env: Bindings,
	input: { uid: string; keepCredentialId: string; revokedAt?: string },
): Promise<number> {
	const result = await d1Run(
		env,
		`UPDATE passkeys SET revoked_at = ?
		 WHERE uid = ? AND credential_id != ? AND revoked_at IS NULL`,
		[input.revokedAt ?? nowIso(), input.uid, input.keepCredentialId],
	);
	return Number(result.meta.changes ?? 0);
}

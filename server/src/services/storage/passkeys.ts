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
	},
) {
	const now = nowIso();
	const result = await d1Run(
		env,
		`INSERT INTO passkeys (
			credential_id, uid, qx, qy, name, registration_source,
			transports_json, revoked_at, created_at, last_used_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
		 ON CONFLICT(credential_id) DO UPDATE SET
			qx = excluded.qx,
			qy = excluded.qy,
			name = COALESCE(excluded.name, passkeys.name),
			registration_source = CASE
				WHEN excluded.registration_source = 'unknown' THEN passkeys.registration_source
				ELSE excluded.registration_source
			END,
			transports_json = COALESCE(excluded.transports_json, passkeys.transports_json),
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
		        transports_json, revoked_at, created_at, last_used_at
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
		        transports_json, revoked_at, created_at, last_used_at
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

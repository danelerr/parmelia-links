import type { Bindings } from "../../middlewares/auth";
import { d1Run, didWrite, nowIso } from "./core";

// ===== D1 leases =====
//
// Owner-bound leases protect event jobs and short transaction-signing critical
// sections. `cron_leases` is the legacy physical table name retained so rolling
// deployments share the same lock domain; no Cron API remains.

export async function acquireLease(
	env: Bindings,
	key: string,
	ttlMs: number,
): Promise<string | null> {
	if (!key || key.length > 160) throw new Error("Invalid lease key");
	const now = nowIso();
	const expiry = new Date(Date.now() + ttlMs).toISOString();
	const owner = crypto.randomUUID();
	// Take over an expired lease...
	const updated = await d1Run(
		env,
		`UPDATE cron_leases SET owner = ?, expires_at = ?, updated_at = ?
		 WHERE key = ? AND expires_at <= ?`,
		[owner, expiry, now, key, now],
	);
	if (didWrite(updated)) return owner;
	// ...or create the lease row the very first time.
	const inserted = await d1Run(
		env,
		`INSERT OR IGNORE INTO cron_leases (key, owner, expires_at, updated_at) VALUES (?, ?, ?, ?)`,
		[key, owner, expiry, now],
	);
	return didWrite(inserted) ? owner : null;
}

export async function renewLease(
	env: Bindings,
	key: string,
	owner: string,
	ttlMs: number,
): Promise<boolean> {
	const now = nowIso();
	const expiry = new Date(Date.now() + ttlMs).toISOString();
	const renewed = await d1Run(
		env,
		`UPDATE cron_leases SET expires_at = ?, updated_at = ? WHERE key = ? AND owner = ?`,
		[expiry, now, key, owner],
	);
	return didWrite(renewed);
}

export async function releaseLease(env: Bindings, key: string, owner: string): Promise<void> {
	await d1Run(env, `DELETE FROM cron_leases WHERE key = ? AND owner = ?`, [
		key,
		owner,
	]);
}



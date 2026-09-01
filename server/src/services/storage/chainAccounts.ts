import type { Bindings } from "../../middlewares/auth";
import { d1All, d1First, d1Run, didWrite, nowIso } from "./core";
import { scheduleEventJob } from "../eventScheduler";

export type ChainAccountStatus = "deploying" | "active" | "failed" | "disabled";
export type ChainSecurityStatus = "current" | "needs_sync" | "syncing" | "failed";

export type UserChainAccountRecord = {
	uid: string;
	chainId: number;
	chainKey: string;
	networkName: string;
	walletAddress: `0x${string}`;
	isHome: boolean;
	status: ChainAccountStatus;
	securityStatus: ChainSecurityStatus;
	securityVersionApplied: number;
	securityVersionDesired: number;
	deploymentTxHash: `0x${string}` | null;
	createdAt: string;
	updatedAt: string;
	activatedAt: string | null;
};

export type ChainBalanceSnapshotRecord = {
	chainId: number;
	asset: string;
	balanceRaw: string;
	decimals: number;
	blockNumber: string;
	blockHash: string;
	observedAt: string;
	canonical: boolean;
};

type ChainAccountRow = {
	uid: string;
	chain_id: number;
	chain_key: string;
	network_name: string;
	wallet_address: `0x${string}`;
	is_home: number;
	status: ChainAccountStatus;
	security_status: ChainSecurityStatus;
	security_version_applied: number;
	security_version_desired: number;
	deployment_tx_hash: `0x${string}` | null;
	created_at: string;
	updated_at: string;
	activated_at: string | null;
};

const COLUMNS = `a.uid, a.chain_id, a.chain_key, a.network_name,
	a.wallet_address, a.is_home, a.status, a.security_status,
	a.security_version_applied,
	COALESCE(v.desired_version, 1) AS security_version_desired,
	a.deployment_tx_hash, a.created_at, a.updated_at, a.activated_at`;

function mapRow(row: ChainAccountRow): UserChainAccountRecord {
	return {
		uid: row.uid,
		chainId: row.chain_id,
		chainKey: row.chain_key,
		networkName: row.network_name,
		walletAddress: row.wallet_address,
		isHome: row.is_home === 1,
		status: row.status,
		securityStatus: row.security_status,
		securityVersionApplied: row.security_version_applied,
		securityVersionDesired: row.security_version_desired,
		deploymentTxHash: row.deployment_tx_hash,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		activatedAt: row.activated_at,
	};
}

export async function listUserChainAccounts(env: Bindings, uid: string): Promise<UserChainAccountRecord[]> {
	const rows = await d1All<ChainAccountRow>(
		env,
		`SELECT ${COLUMNS}
		 FROM user_chain_accounts a
		 LEFT JOIN account_security_versions v ON v.uid = a.uid
		 WHERE a.uid = ?
		 ORDER BY a.is_home DESC, a.chain_id`,
		[uid],
	);
	return rows.map(mapRow);
}

export async function getUserChainAccount(
	env: Bindings,
	uid: string,
	chainId: number,
): Promise<UserChainAccountRecord | null> {
	const row = await d1First<ChainAccountRow>(
		env,
		`SELECT ${COLUMNS}
		 FROM user_chain_accounts a
		 LEFT JOIN account_security_versions v ON v.uid = a.uid
		 WHERE a.uid = ? AND a.chain_id = ? LIMIT 1`,
		[uid, chainId],
	);
	return row ? mapRow(row) : null;
}

/** Resolve ownership using the address namespace of one explicit chain. */
export async function getActiveChainAccountOwner(
	env: Bindings,
	chainId: number,
	walletAddress: string,
): Promise<{ uid: string; username: string | null } | null> {
	const normalized = walletAddress.trim().toLowerCase();
	if (!/^0x[0-9a-f]{40}$/u.test(normalized)) return null;
	return d1First<{ uid: string; username: string | null }>(
		env,
		`SELECT a.uid, u.username
		 FROM user_chain_accounts a
		 JOIN users u ON u.uid = a.uid
		 WHERE a.chain_id = ? AND a.wallet_address = ? AND a.status = 'active'
		 LIMIT 1`,
		[chainId, normalized],
	);
}

export async function listActiveChainAccountOwnersByWalletAddresses(
	env: Bindings,
	chainId: number,
	walletAddresses: readonly string[],
): Promise<Array<{ uid: string; walletAddress: string }>> {
	const normalized = [...new Set(
		walletAddresses
			.map((address) => address.trim().toLowerCase())
			.filter((address) => /^0x[0-9a-f]{40}$/u.test(address)),
	)];
	if (normalized.length === 0) return [];
	const owners: Array<{ uid: string; walletAddress: string }> = [];
	for (let offset = 0; offset < normalized.length; offset += 100) {
		const chunk = normalized.slice(offset, offset + 100);
		const placeholders = chunk.map(() => "?").join(", ");
		const rows = await d1All<{ uid: string; wallet_address: string }>(
			env,
			`SELECT uid, wallet_address
			 FROM user_chain_accounts
			 WHERE chain_id = ? AND status = 'active'
			   AND wallet_address IN (${placeholders})`,
			[chainId, ...chunk],
		);
		owners.push(...rows.map((row) => ({
			uid: row.uid,
			walletAddress: row.wallet_address,
		})));
	}
	return owners;
}

export async function listUserChainBalanceSnapshots(
	env: Bindings,
	uid: string,
): Promise<ChainBalanceSnapshotRecord[]> {
	const rows = await d1All<{
		chain_id: number;
		asset: string;
		balance_raw: string;
		decimals: number;
		block_number: number | string;
		block_hash: string;
		observed_at: string;
		canonical: number;
	}>(
		env,
		`SELECT chain_id, asset, balance_raw, decimals, block_number,
		        block_hash, observed_at, canonical
		 FROM balance_snapshots
		 WHERE uid = ? AND canonical = 1
		 ORDER BY chain_id, asset`,
		[uid],
	);
	return rows.map((row) => ({
		chainId: row.chain_id,
		asset: row.asset,
		balanceRaw: row.balance_raw,
		decimals: row.decimals,
		blockNumber: String(row.block_number),
		blockHash: row.block_hash,
		observedAt: row.observed_at,
		canonical: row.canonical === 1,
	}));
}

export async function upsertUserChainAccount(
	env: Bindings,
	input: {
		uid: string;
		chainId: number;
		chainKey: string;
		networkName: string;
		walletAddress: string;
		isHome: boolean;
		status: ChainAccountStatus;
		securityStatus?: ChainSecurityStatus;
		securityVersionApplied?: number;
		deploymentTxHash?: string | null;
	},
): Promise<void> {
	const now = nowIso();
	if (!input.isHome && input.status === "active") {
		await scheduleEventJob(env, "indexer_wallet_registry", {
			delayMs: 2_000,
			reason: "satellite_wallet_registered_backfill",
		});
	}
	await d1Run(
		env,
		`INSERT INTO account_security_versions(uid, desired_version, updated_at)
		 VALUES (?, 1, ?)
		 ON CONFLICT(uid) DO NOTHING`,
		[input.uid, now],
	);
	await d1Run(
		env,
		`INSERT INTO user_chain_accounts (
			uid, chain_id, chain_key, network_name, wallet_address, is_home,
			status, security_status, security_version_applied,
			deployment_tx_hash, created_at, updated_at, activated_at
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?,
		COALESCE(?, (SELECT desired_version FROM account_security_versions WHERE uid = ?)),
			?, ?, ?, CASE WHEN ? = 'active' THEN ? ELSE NULL END)
		 ON CONFLICT(uid, chain_id) DO UPDATE SET
			chain_key = excluded.chain_key,
			network_name = excluded.network_name,
			wallet_address = excluded.wallet_address,
			is_home = excluded.is_home,
			status = excluded.status,
			security_status = excluded.security_status,
			security_version_applied = CASE
				WHEN excluded.status = 'active' THEN excluded.security_version_applied
				ELSE user_chain_accounts.security_version_applied
			END,
			deployment_tx_hash = COALESCE(excluded.deployment_tx_hash, user_chain_accounts.deployment_tx_hash),
			updated_at = excluded.updated_at,
			activated_at = COALESCE(user_chain_accounts.activated_at, excluded.activated_at)`,
		[
			input.uid,
			input.chainId,
			input.chainKey,
			input.networkName,
			input.walletAddress.toLowerCase(),
			input.isHome ? 1 : 0,
			input.status,
			input.securityStatus ?? (input.status === "active" ? "current" : "syncing"),
			input.securityVersionApplied ?? null,
			input.uid,
			input.deploymentTxHash?.toLowerCase() ?? null,
			now,
			now,
			input.status,
			now,
		],
	);
	if (!input.isHome && input.status === "active") {
		// Close the activation/passkey-change race. If a passkey trigger ran before
		// this activation it could not update the then-deploying row; if it runs
		// after this statement it marks the now-active row itself. This correction
		// covers every ordering without a distributed lock.
		await d1Run(
			env,
			`UPDATE user_chain_accounts
			 SET security_status = CASE
			       WHEN security_version_applied = (
			         SELECT desired_version FROM account_security_versions
			         WHERE uid = user_chain_accounts.uid
			       ) THEN 'current'
			       ELSE 'needs_sync'
			     END,
			     updated_at = ?
			 WHERE uid = ? AND chain_id = ? AND is_home = 0 AND status = 'active'`,
			[nowIso(), input.uid, input.chainId],
		);
	}
}

/**
 * Mark a satellite's signer set as synchronized only when the global desired
 * version is still the version that was signed. A concurrent passkey change
 * leaves the account in needs_sync instead of falsely declaring it current.
 */
export async function completeUserChainSecuritySync(
	env: Bindings,
	input: { uid: string; chainId: number; expectedVersion: number },
): Promise<boolean> {
	const now = nowIso();
	const result = await d1Run(
		env,
		`UPDATE user_chain_accounts
		 SET security_status = 'current',
		     security_version_applied = ?,
		     updated_at = ?
		 WHERE uid = ? AND chain_id = ? AND is_home = 0 AND status = 'active'
		   AND EXISTS (
		     SELECT 1 FROM account_security_versions v
		     WHERE v.uid = user_chain_accounts.uid AND v.desired_version = ?
		   )`,
		[input.expectedVersion, now, input.uid, input.chainId, input.expectedVersion],
	);
	return didWrite(result);
}

/**
 * Complete a coordinated recovery after every active chain has independently
 * proven the recovered signer set on-chain. Passkey triggers can advance the
 * desired version more than once while the old credentials are revoked and
 * the new one is stored, so this deliberately reads the final version inside
 * the UPDATE instead of accepting a version captured before those writes.
 */
export async function completeRecoveredUserChainSecurity(
	env: Bindings,
	input: { uid: string },
): Promise<number> {
	const now = nowIso();
	const result = await d1Run(
		env,
		`UPDATE user_chain_accounts
		 SET security_status = 'current',
		     security_version_applied = (
		       SELECT desired_version FROM account_security_versions
		       WHERE uid = user_chain_accounts.uid
		     ),
		     updated_at = ?
		 WHERE uid = ? AND status = 'active'
		   AND EXISTS (
		     SELECT 1 FROM account_security_versions v
		     WHERE v.uid = user_chain_accounts.uid
		   )`,
		[now, input.uid],
	);
	return Number(result.meta?.changes ?? 0);
}

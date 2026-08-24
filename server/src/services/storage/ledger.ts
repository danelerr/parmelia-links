import type { Bindings } from "../../middlewares/auth";
import {
	createChainEpochGuard,
	prepareChainEpochGuardDelete,
	prepareChainEpochGuardInsert,
} from "../chainEpoch";
import { d1All, nowIso } from "./core";

// ===== Ledger (unified movements) =====

type LedgerKind = "payment" | "link" | "swap" | "fund" | "external" | "earn";

export type LedgerEntry = {
	/** Present on read models; writers leave it unset and D1 generates the id. */
	id?: string;
	uid: string;
	direction: "in" | "out";
	kind: LedgerKind;
	txHash: string;
	/** Only for indexer-ingested on-chain entries (dedup key). */
	logIndex?: number | null;
	token: string;
	amount: string;
	amountSource?: "executed" | "estimated";
	amountRaw?: string | null;
	decimals?: number | null;
	chainId?: number | null;
	blockNumber?: bigint | null;
	blockHash?: string | null;
	transactionIndex?: number | null;
	consistencyLevel?: string | null;
	projectionVersion?: number | null;
	counterparty?: string | null;
	counterpartyUid?: string | null;
	counterpartyUsername?: string | null;
	counterpartyDisplayName?: string | null;
	reference?: string | null;
	linkId?: string | null;
	createdAt: string;
};

export type LedgerUserEvent = {
	dedupeKey: string;
	uid: string;
	eventType: string;
	payload: Record<string, unknown>;
	priority?: 0 | 1 | 2 | 3 | 4;
};

export async function enqueueUserEvent(
	env: Bindings,
	effect: LedgerUserEvent,
): Promise<boolean> {
	const now = nowIso();
	const result = await env.GATOPAGO_DB.prepare(
		`INSERT OR IGNORE INTO user_event_outbox (
			id, dedupe_key, uid, event_type, payload_json, priority,
			status, attempt_count, next_attempt_at, lease_owner,
			lease_expires_at, last_error_code, created_at, updated_at,
			delivered_at
		 ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL,
		           ?, ?, NULL)`,
	).bind(
		effect.dedupeKey,
		effect.dedupeKey,
		effect.uid,
		effect.eventType,
		JSON.stringify(effect.payload),
		effect.priority ?? 2,
		now,
		now,
		now,
	).run();
	return result.success && result.meta.changes === 1;
}

type LedgerRow = {
	id: string;
	uid: string;
	direction: "in" | "out";
	kind: LedgerKind;
	tx_hash: string;
	log_index: number | null;
	token: string;
	amount: string;
	amount_source: "executed" | "estimated";
	amount_raw: string | null;
	decimals: number | null;
	chain_id: number | null;
	block_number: number | string | null;
	block_hash: string | null;
	transaction_index: number | null;
	consistency_level: string | null;
	projection_version: number | null;
	counterparty: string | null;
	counterparty_uid: string | null;
	counterparty_username?: string | null;
	counterparty_display_name?: string | null;
	reference: string | null;
	link_id: string | null;
	created_at: string;
};

/**
 * Idempotent append (the dedup unique index absorbs re-submissions/re-scans).
 * Runs as ONE atomic D1 batch so double-entry pairs (payer out / recipient in)
 * can never be half-written. Returns one boolean per entry: true if the row was
 * actually inserted, false if the dedup index absorbed it (lets callers notify
 * only on genuinely new movements).
 */
export async function writeLedgerEntries(
	env: Bindings,
	entries: LedgerEntry[],
	options: {
		userEvents?: LedgerUserEvent[];
		expectedReorgEpoch?: number;
	} = {},
): Promise<boolean[]> {
	if (entries.length === 0) return [];
	const chainIds = new Set(
		entries.flatMap((entry) =>
			entry.chainId === null || entry.chainId === undefined
				? []
				: [entry.chainId],
		),
	);
	if (options.expectedReorgEpoch !== undefined && chainIds.size !== 1) {
		throw new Error(
			"Epoch-guarded ledger writes must belong to exactly one chain",
		);
	}
	const guardedChainId =
		options.expectedReorgEpoch === undefined
			? null
			: [...chainIds][0];
	const epochGuard =
		guardedChainId === null
			? null
			: createChainEpochGuard(
					guardedChainId,
					options.expectedReorgEpoch!,
				);
	const stmt = env.GATOPAGO_DB.prepare(
		`INSERT OR IGNORE INTO ledger (
			id, uid, direction, kind, tx_hash, log_index, token, amount, amount_source,
			amount_raw, decimals, chain_id, block_number, block_hash, transaction_index,
			consistency_level, projection_version, counterparty, counterparty_uid,
			reference, link_id, created_at, canonical
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
		ON CONFLICT DO UPDATE SET
			amount = excluded.amount,
			amount_source = excluded.amount_source,
			amount_raw = excluded.amount_raw,
			decimals = excluded.decimals,
			chain_id = excluded.chain_id,
			block_number = excluded.block_number,
			block_hash = excluded.block_hash,
			transaction_index = excluded.transaction_index,
			consistency_level = excluded.consistency_level,
			projection_version = excluded.projection_version,
			counterparty = excluded.counterparty,
			counterparty_uid = excluded.counterparty_uid,
			reference = excluded.reference,
			link_id = excluded.link_id,
			created_at = excluded.created_at,
			canonical = 1
		WHERE ledger.canonical = 0 AND excluded.block_hash IS NOT NULL`,
	);
	const entryStatements = entries.map((entry) =>
		stmt.bind(
			crypto.randomUUID(),
			entry.uid,
			entry.direction,
			entry.kind,
			entry.txHash,
			entry.logIndex ?? null,
			entry.token,
			entry.amount,
			entry.amountSource ?? "executed",
			entry.amountRaw ?? null,
			entry.decimals ?? null,
			entry.chainId ?? null,
			entry.blockNumber?.toString() ?? null,
			entry.blockHash?.toLowerCase() ?? null,
			entry.transactionIndex ?? null,
			entry.consistencyLevel ?? null,
			entry.projectionVersion ?? null,
			entry.counterparty?.toLowerCase() ?? null,
			entry.counterpartyUid ?? null,
			entry.reference ?? null,
			entry.linkId ?? null,
			entry.createdAt,
		),
	);
	const now = nowIso();
	const userEventStatements = (options.userEvents ?? []).map((effect) =>
		env.GATOPAGO_DB.prepare(
			`INSERT OR IGNORE INTO user_event_outbox (
				id, dedupe_key, uid, event_type, payload_json, priority,
				status, attempt_count, next_attempt_at, lease_owner,
				lease_expires_at, last_error_code, created_at, updated_at,
				delivered_at
			 ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, NULL, NULL, NULL,
			           ?, ?, NULL)`,
		).bind(
			effect.dedupeKey,
			effect.dedupeKey,
			effect.uid,
			effect.eventType,
			JSON.stringify(effect.payload),
			effect.priority ?? 2,
			now,
			now,
			now,
		),
	);
	const statements = [
		...(epochGuard
			? [prepareChainEpochGuardInsert(env, epochGuard)]
			: []),
		...entryStatements,
		...userEventStatements,
		...(epochGuard
			? [prepareChainEpochGuardDelete(env, epochGuard)]
			: []),
	];
	const results = await env.GATOPAGO_DB.batch(statements);
	const entryResultOffset = epochGuard ? 1 : 0;
	return results
		.slice(entryResultOffset, entryResultOffset + entries.length)
		.map((result) => (result.meta?.changes ?? 0) > 0);
}

export const LEDGER_PAGE_DEFAULT = 50;
export const LEDGER_PAGE_MAX = 100;

type LedgerPageCursor = {
	v: 1;
	createdAt: string;
	id: string;
};

export class InvalidLedgerCursorError extends Error {
	constructor() {
		super("Invalid ledger pagination cursor");
		this.name = "InvalidLedgerCursorError";
	}
}

function encodeLedgerCursor(cursor: Omit<LedgerPageCursor, "v">): string {
	return btoa(JSON.stringify({ v: 1, ...cursor } satisfies LedgerPageCursor))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(/=+$/u, "");
}

function decodeLedgerCursor(value: string): LedgerPageCursor {
	try {
		if (
			value.length < 1 ||
			value.length > 512 ||
			!/^[A-Za-z0-9_-]+$/u.test(value)
		) {
			throw new InvalidLedgerCursorError();
		}
		const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
		const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
		const parsed = JSON.parse(atob(padded)) as Partial<LedgerPageCursor>;
		if (
			parsed.v !== 1 ||
			typeof parsed.createdAt !== "string" ||
			parsed.createdAt.length < 20 ||
			parsed.createdAt.length > 40 ||
			!Number.isFinite(Date.parse(parsed.createdAt)) ||
			typeof parsed.id !== "string" ||
			parsed.id.length < 1 ||
			parsed.id.length > 128
		) {
			throw new InvalidLedgerCursorError();
		}
		return {
			v: 1,
			createdAt: parsed.createdAt,
			id: parsed.id,
		};
	} catch (error) {
		if (error instanceof InvalidLedgerCursorError) throw error;
		throw new InvalidLedgerCursorError();
	}
}

function ledgerEntryFromRow(row: LedgerRow): LedgerEntry {
	return {
		id: row.id,
		uid: row.uid,
		direction: row.direction,
		kind: row.kind,
		txHash: row.tx_hash,
		logIndex: row.log_index,
		token: row.token,
		amount: row.amount,
		amountSource: row.amount_source,
		amountRaw: row.amount_raw,
		decimals: row.decimals,
		chainId: row.chain_id,
		blockNumber: row.block_number === null ? null : BigInt(row.block_number),
		blockHash: row.block_hash,
		transactionIndex: row.transaction_index,
		consistencyLevel: row.consistency_level,
		projectionVersion: row.projection_version,
		counterparty: row.counterparty,
		counterpartyUid: row.counterparty_uid,
		counterpartyUsername: row.counterparty_username ?? null,
		counterpartyDisplayName: row.counterparty_display_name ?? null,
		reference: row.reference,
		linkId: row.link_id,
		createdAt: row.created_at,
	};
}

export async function listLedgerPageByUid(
	env: Bindings,
	uid: string,
	options: { limit?: number; before?: string | null } = {},
): Promise<{ entries: LedgerEntry[]; nextCursor: string | null }> {
	const limit = Math.min(
		LEDGER_PAGE_MAX,
		Math.max(1, Math.trunc(options.limit ?? LEDGER_PAGE_DEFAULT)),
	);
	const before = options.before ? decodeLedgerCursor(options.before) : null;
	// created_at is always an ISO-8601 string for ledger writers. Keyset
	// pagination plus id is stable under concurrent inserts and uses the
	// idx_ledger_uid_canonical_created_id covering order.
	const selection = `SELECT l.id, l.uid, l.direction, l.kind, l.tx_hash,
			l.log_index, l.token, l.amount, l.amount_source, l.amount_raw,
			l.decimals, l.chain_id, l.block_number, l.block_hash,
			l.transaction_index, l.consistency_level, l.projection_version,
			l.counterparty, l.counterparty_uid, l.reference, l.link_id,
			l.created_at, counterparty_user.username AS counterparty_username,
			counterparty_user.display_name AS counterparty_display_name
		 FROM ledger AS l
		 LEFT JOIN users AS counterparty_user
		   ON counterparty_user.uid = l.counterparty_uid
		 WHERE l.uid = ? AND l.canonical = 1`;
	const rows = before
		? await d1All<LedgerRow>(
				env,
				`${selection}
				 AND (
					l.created_at < ?
					OR (l.created_at = ? AND l.id < ?)
				 )
				 ORDER BY l.created_at DESC, l.id DESC
				 LIMIT ?`,
				[uid, before.createdAt, before.createdAt, before.id, limit + 1],
			)
		: await d1All<LedgerRow>(
				env,
				`${selection}
				 ORDER BY l.created_at DESC, l.id DESC
				 LIMIT ?`,
				[uid, limit + 1],
			);
	const hasNext = rows.length > limit;
	const pageRows = hasNext ? rows.slice(0, limit) : rows;
	const tail = pageRows.at(-1);
	return {
		entries: pageRows.map(ledgerEntryFromRow),
		nextCursor:
			hasNext && tail
				? encodeLedgerCursor({ createdAt: tail.created_at, id: tail.id })
				: null,
	};
}

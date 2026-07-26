import type { Address, Hex } from "viem";
import type { Bindings } from "../middlewares/auth";
import { scheduleEventJob } from "./eventScheduler";

export type ChainConsistencyLevel =
	| "sequenced"
	| "batch_posted"
	| "l1_confirmed"
	| "assertion_confirmed"
	| "safe"
	| "finalized";

export type JournalBlock = {
	chainId: number;
	blockNumber: bigint;
	blockHash: Hex;
	parentHash?: Hex | null;
	timestamp?: bigint | null;
	consistencyLevel: ChainConsistencyLevel;
	source: string;
	observedAt: string;
	l1BatchNumber?: bigint | null;
	l1Confirmations?: bigint | null;
};

export type JournalEventAccount = {
	uid: string;
	accountAddress: Address;
	asset: string;
	role: "from" | "to" | "account" | "payer" | "recipient";
	deltaRaw?: bigint | null;
};

export type JournalEvent = {
	txHash: Hex;
	logIndex: number;
	eventKind: string;
	blockNumber: bigint;
	blockHash: Hex;
	transactionIndex?: number | null;
	contractAddress: Address;
	topic0?: Hex | null;
	payload: Record<string, unknown>;
	source: string;
	observedAt: string;
	canonical?: boolean;
	accounts?: JournalEventAccount[];
};

export type JournalWriteResult = {
	insertedEventIds: Set<string>;
	duplicateEventIds: Set<string>;
	enqueuedUserEvents: number;
	projectedUserOperations: number;
	checkpointAdvanced: boolean;
};

export type JournalUserEvent = {
	dedupeKey: string;
	uid: string;
	eventType: string;
	payload: Record<string, unknown>;
	priority?: 0 | 1 | 2 | 3 | 4;
};

export type JournalUserOperationReceipt = {
	userOpHash: Hex;
	txHash: Hex;
	logIndex: number;
	eventKind: "entrypoint.UserOperationEvent";
	blockNumber: bigint;
	blockHash: Hex;
	transactionIndex?: number | null;
	sender: Address;
	nonce: bigint;
	success: boolean;
	actualGasCost: bigint;
	actualGasUsed: bigint;
	source: string;
	observedAt: string;
};

function isoFromBlockTimestamp(timestamp: bigint | null | undefined): string | null {
	if (timestamp === null || timestamp === undefined) return null;
	const milliseconds = timestamp * 1_000n;
	if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) return null;
	return new Date(Number(milliseconds)).toISOString();
}

export function chainEventId(
	chainId: number,
	txHash: string,
	logIndex: number,
	eventKind: string,
): string {
	return `${chainId}:${txHash.toLowerCase()}:${logIndex}:${eventKind}`;
}

function jsonWithBigInts(value: Record<string, unknown>): string {
	return JSON.stringify(value, (_key, nested) =>
		typeof nested === "bigint" ? nested.toString() : nested,
	);
}

/**
 * Atomically persists one canonical block, all normalized events in that block,
 * their affected accounts, and the stream checkpoint.
 *
 * D1 batch executes as a transaction. If any statement fails, the checkpoint
 * does not advance, and the next delivery safely retries the same data.
 */
export async function journalBlockEvents(
	env: Bindings,
	input: {
		stream: string;
		block: JournalBlock;
		events: JournalEvent[];
		userEvents?: JournalUserEvent[];
		userOperationReceipts?: JournalUserOperationReceipt[];
	},
): Promise<JournalWriteResult> {
	const { block } = input;
	const canonicalEvents = input.events.filter(
		(event) =>
			event.blockNumber === block.blockNumber &&
			event.blockHash.toLowerCase() === block.blockHash.toLowerCase(),
	);
	if (canonicalEvents.length !== input.events.length) {
		throw new Error("Journal batch contains events from a different block");
	}
	const canonicalUserOperations = (input.userOperationReceipts ?? []).filter(
		(receipt) =>
			receipt.blockNumber === block.blockNumber &&
			receipt.blockHash.toLowerCase() === block.blockHash.toLowerCase(),
	);
	if (
		canonicalUserOperations.length !==
		(input.userOperationReceipts?.length ?? 0)
	) {
		throw new Error(
			"Journal batch contains UserOperation evidence from a different block",
		);
	}

	const statements: D1PreparedStatement[] = [];
	const insertResultIndexes: Array<{ index: number; eventId: string }> = [];
	const userEventResultIndexes: number[] = [];
	const userOperationResultIndexes: number[] = [];
	const now = block.observedAt;

	// A height can have several observed hashes for audit, but only one canonical
	// row. Marking the previous row first satisfies the partial unique index.
	statements.push(
		env.PARMELIA_DB.prepare(
			`UPDATE chain_blocks
			 SET canonical = 0
			 WHERE chain_id = ? AND block_number = ? AND block_hash <> ? AND canonical = 1`,
		).bind(block.chainId, block.blockNumber.toString(), block.blockHash.toLowerCase()),
	);
	statements.push(
		env.PARMELIA_DB.prepare(
			`INSERT OR IGNORE INTO chain_blocks (
				chain_id, block_number, block_hash, parent_hash, block_timestamp,
				consistency_level, canonical, source, observed_at, l1_batch_number,
				l1_confirmations
			 ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
		).bind(
			block.chainId,
			block.blockNumber.toString(),
			block.blockHash.toLowerCase(),
			block.parentHash?.toLowerCase() ?? null,
			isoFromBlockTimestamp(block.timestamp),
			block.consistencyLevel,
			block.source,
			now,
			block.l1BatchNumber?.toString() ?? null,
			block.l1Confirmations?.toString() ?? null,
		),
	);
	statements.push(
		env.PARMELIA_DB.prepare(
			`UPDATE chain_blocks
			 SET parent_hash = COALESCE(?, parent_hash),
			     block_timestamp = COALESCE(?, block_timestamp),
			     consistency_level = ?,
			     canonical = 1,
			     source = ?,
			     observed_at = ?,
			     l1_batch_number = COALESCE(?, l1_batch_number),
			     l1_confirmations = COALESCE(?, l1_confirmations)
			 WHERE chain_id = ? AND block_number = ? AND block_hash = ?`,
		).bind(
			block.parentHash?.toLowerCase() ?? null,
			isoFromBlockTimestamp(block.timestamp),
			block.consistencyLevel,
			block.source,
			now,
			block.l1BatchNumber?.toString() ?? null,
			block.l1Confirmations?.toString() ?? null,
			block.chainId,
			block.blockNumber.toString(),
			block.blockHash.toLowerCase(),
		),
	);

	for (const event of canonicalEvents) {
		const eventId = chainEventId(
			block.chainId,
			event.txHash,
			event.logIndex,
			event.eventKind,
		);
		const canonical = event.canonical === false ? 0 : 1;

		if (canonical === 1) {
			statements.push(
				env.PARMELIA_DB.prepare(
					`UPDATE chain_events
					 SET canonical = 0
					 WHERE chain_id = ? AND tx_hash = ? AND log_index = ?
					   AND event_kind = ? AND block_hash <> ? AND canonical = 1`,
				).bind(
					block.chainId,
					event.txHash.toLowerCase(),
					event.logIndex,
					event.eventKind,
					event.blockHash.toLowerCase(),
				),
			);
		}

		const insertIndex = statements.length;
		statements.push(
			env.PARMELIA_DB.prepare(
				`INSERT OR IGNORE INTO chain_events (
					event_id, chain_id, tx_hash, log_index, event_kind, block_number,
					block_hash, transaction_index, contract_address, topic0,
					payload_json, canonical, source, observed_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			).bind(
				eventId,
				block.chainId,
				event.txHash.toLowerCase(),
				event.logIndex,
				event.eventKind,
				event.blockNumber.toString(),
				event.blockHash.toLowerCase(),
				event.transactionIndex ?? null,
				event.contractAddress.toLowerCase(),
				event.topic0?.toLowerCase() ?? null,
				jsonWithBigInts(event.payload),
				canonical,
				event.source,
				event.observedAt,
			),
		);
		insertResultIndexes.push({ index: insertIndex, eventId });

		// A duplicate delivery may upgrade an occurrence from noncanonical to
		// canonical, but never creates a second journal row.
		statements.push(
			env.PARMELIA_DB.prepare(
				`UPDATE chain_events
				 SET canonical = ?, source = ?, observed_at = ?
				 WHERE event_id = ? AND block_hash = ?`,
			).bind(
				canonical,
				event.source,
				event.observedAt,
				eventId,
				event.blockHash.toLowerCase(),
			),
		);

		for (const account of event.accounts ?? []) {
			statements.push(
				env.PARMELIA_DB.prepare(
					`INSERT OR IGNORE INTO chain_event_accounts (
						event_id, block_hash, uid, account_address, asset, role, delta_raw
					 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
				).bind(
					eventId,
					event.blockHash.toLowerCase(),
					account.uid,
					account.accountAddress.toLowerCase(),
					account.asset,
					account.role,
					account.deltaRaw?.toString() ?? null,
				),
			);
		}
	}

	for (const effect of input.userEvents ?? []) {
		userEventResultIndexes.push(statements.length);
		statements.push(
			env.PARMELIA_DB.prepare(
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
				jsonWithBigInts(effect.payload),
				effect.priority ?? 2,
				now,
				now,
				now,
			),
		);
	}

	for (const receipt of canonicalUserOperations) {
		const eventId = chainEventId(
			block.chainId,
			receipt.txHash,
			receipt.logIndex,
			receipt.eventKind,
		);
		// Preserve every observed occurrence, but allow only one canonical
		// occurrence for a (chain, userOpHash). A re-inclusion after a reorg
		// therefore remains fully auditable.
		statements.push(
			env.PARMELIA_DB.prepare(
				`UPDATE user_operation_receipts
				 SET canonical = 0
				 WHERE chain_id = ? AND user_op_hash = ?
				   AND block_hash <> ? AND canonical = 1`,
			).bind(
				block.chainId,
				receipt.userOpHash.toLowerCase(),
				receipt.blockHash.toLowerCase(),
			),
		);
		userOperationResultIndexes.push(statements.length);
		statements.push(
			env.PARMELIA_DB.prepare(
				`INSERT INTO user_operation_receipts (
					chain_id, user_op_hash, event_id, tx_hash, block_number,
					block_hash, log_index, transaction_index, sender, nonce,
					success, actual_gas_cost, actual_gas_used, consistency_level,
					canonical, source, observed_at
				 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
				 ON CONFLICT(chain_id, user_op_hash, block_hash) DO UPDATE SET
				 	event_id = excluded.event_id,
				 	tx_hash = excluded.tx_hash,
				 	block_number = excluded.block_number,
				 	block_hash = excluded.block_hash,
				 	log_index = excluded.log_index,
				 	transaction_index = excluded.transaction_index,
				 	sender = excluded.sender,
				 	nonce = excluded.nonce,
				 	success = excluded.success,
				 	actual_gas_cost = excluded.actual_gas_cost,
				 	actual_gas_used = excluded.actual_gas_used,
				 	consistency_level = excluded.consistency_level,
				 	canonical = 1,
				 	source = excluded.source,
				 	observed_at = excluded.observed_at`,
			).bind(
				block.chainId,
				receipt.userOpHash.toLowerCase(),
				eventId,
				receipt.txHash.toLowerCase(),
				receipt.blockNumber.toString(),
				receipt.blockHash.toLowerCase(),
				receipt.logIndex,
				receipt.transactionIndex ?? null,
				receipt.sender.toLowerCase(),
				receipt.nonce.toString(),
				receipt.success ? 1 : 0,
				receipt.actualGasCost.toString(),
				receipt.actualGasUsed.toString(),
				block.consistencyLevel,
				receipt.source,
				receipt.observedAt,
			),
		);
	}

	const checkpointIndex = statements.length;
	statements.push(
		env.PARMELIA_DB.prepare(
			`INSERT INTO chain_stream_checkpoints (
				chain_id, stream, block_number, block_hash, consistency_level, updated_at
			 ) VALUES (?, ?, ?, ?, ?, ?)
			 ON CONFLICT(chain_id, stream) DO UPDATE SET
			 	block_number = excluded.block_number,
			 	block_hash = excluded.block_hash,
			 	consistency_level = excluded.consistency_level,
			 	updated_at = excluded.updated_at
			 WHERE excluded.block_number > chain_stream_checkpoints.block_number
			    OR (
			    	excluded.block_number = chain_stream_checkpoints.block_number
			    	AND excluded.block_hash = chain_stream_checkpoints.block_hash
			    )`,
		).bind(
			block.chainId,
			input.stream,
			block.blockNumber.toString(),
			block.blockHash.toLowerCase(),
			block.consistencyLevel,
			now,
		),
	);

	const results = await env.PARMELIA_DB.batch(statements);
	const insertedEventIds = new Set<string>();
	const duplicateEventIds = new Set<string>();
	for (const { index, eventId } of insertResultIndexes) {
		if ((results[index]?.meta?.changes ?? 0) > 0) insertedEventIds.add(eventId);
		else duplicateEventIds.add(eventId);
	}
	const result = {
		insertedEventIds,
		duplicateEventIds,
		enqueuedUserEvents: userEventResultIndexes.filter(
			(index) => (results[index]?.meta?.changes ?? 0) > 0,
		).length,
		projectedUserOperations: userOperationResultIndexes.filter(
			(index) => (results[index]?.meta?.changes ?? 0) > 0,
		).length,
		checkpointAdvanced: (results[checkpointIndex]?.meta?.changes ?? 0) > 0,
	};
	const wakeups: Promise<boolean>[] = [];
	if (result.projectedUserOperations > 0) {
		wakeups.push(
			scheduleEventJob(env, "payment_reconciler", {
				reason: "canonical_userop_projected",
			}),
		);
	}
	if (wakeups.length > 0) await Promise.all(wakeups);
	return result;
}

export async function recordSourceDelivery(
	env: Bindings,
	input: {
		provider: string;
		deliveryId: string;
		webhookId?: string | null;
		status: "received" | "processed" | "rejected";
		eventCount?: number;
		errorCode?: string | null;
	},
): Promise<boolean> {
	const now = new Date().toISOString();
	const result = await env.PARMELIA_DB.prepare(
		`INSERT OR IGNORE INTO chain_source_deliveries (
			provider, delivery_id, webhook_id, status, event_count,
			first_seen_at, processed_at, last_error_code
		 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			input.provider,
			input.deliveryId,
			input.webhookId ?? null,
			input.status,
			input.eventCount ?? 0,
			now,
			input.status === "processed" ? now : null,
			input.errorCode ?? null,
		)
		.run();
	return (result.meta?.changes ?? 0) > 0;
}

export type SourceDeliveryRecord = {
	status: "received" | "processed" | "rejected";
	eventCount: number;
};

export async function getSourceDelivery(
	env: Bindings,
	provider: string,
	deliveryId: string,
): Promise<SourceDeliveryRecord | null> {
	const row = await env.PARMELIA_DB.prepare(
		`SELECT status, event_count
		 FROM chain_source_deliveries
		 WHERE provider = ? AND delivery_id = ?`,
	)
		.bind(provider, deliveryId)
		.first<{
			status: SourceDeliveryRecord["status"];
			event_count: number;
		}>();
	return row ? { status: row.status, eventCount: row.event_count } : null;
}

export async function finishSourceDelivery(
	env: Bindings,
	provider: string,
	deliveryId: string,
	status: "processed" | "rejected",
	eventCount: number,
	errorCode: string | null = null,
): Promise<void> {
	await env.PARMELIA_DB.prepare(
		`UPDATE chain_source_deliveries
		 SET status = ?, event_count = ?, processed_at = ?, last_error_code = ?
		 WHERE provider = ? AND delivery_id = ?`,
	)
		.bind(
			status,
			eventCount,
			new Date().toISOString(),
			errorCode,
			provider,
			deliveryId,
		)
		.run();
}

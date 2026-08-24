import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
	acquireLease,
	claimPendingForSubmit,
	createAccountOperation,
	createCrosschainOp,
	createPendingPayment,
	finishAccountOperation,
	getActiveAccountOperation,
	getCrosschainOpById,
	getSyncCursor,
	listLedgerPageByUid,
	releaseLease,
	renewLease,
	setSyncCursor,
	updateCrosschainOp,
	writeLedgerEntries,
	type PendingPaymentRecord,
} from "../src/services/storage";
import { settlePayment } from "../src/services/settlement";
import { hmacSha256Hex } from "../src/services/webhooks";
import { SignerLeaseBusyError, withSignerLease } from "../src/services/signerLease";
import {
	assignWalletToStableShard,
	listIndexerShardIds,
	listWalletsForIndexerShard,
} from "../src/services/indexerShards";
import { journalBlockEvents } from "../src/services/chainJournal";
import { projectBalanceDeltas } from "../src/services/balanceProjector";
import {
	listBalanceSnapshots,
	requestBalanceRefresh,
	upsertBalanceSnapshots,
} from "../src/services/balanceReadModel";
import { verifyAndRecoverStream } from "../src/services/reorg";
import { __test as rpcControlTest } from "../src/services/rpcControlPlane";

describe.sequential("Cloudflare Worker runtime", () => {
	it("does not load developer secrets", () => {
		expect(env.FCM_SERVICE_ACCOUNT).toBeUndefined();
		expect(env.FAUCET_PRIVATE_KEY).toBeUndefined();
		expect(env.PAYMASTER_SIGNER_PRIVATE_KEY).toBeUndefined();
		expect(env.RECOVERY_GUARDIAN_PRIVATE_KEY).toBeUndefined();
	});

	it("applies the complete D1 migration chain", async () => {
		const applied = await env.GATOPAGO_DB.prepare(
			"SELECT name FROM d1_migrations ORDER BY id",
		).all<{ name: string }>();

		expect(applied.results.map((row) => row.name)).toEqual([
			"0001_schema.sql",
			"0002_api.sql",
			"0003_router.sql",
			"0004_push_tokens.sql",
			"0005_crosschain.sql",
			"0006_hardening.sql",
			"0007_payment_lifecycle.sql",
			"0008_earn.sql",
			"0009_profile.sql",
			"0010_integrity.sql",
			"0011_account_operations.sql",
			"0012_chain_journal.sql",
			"0013_home_read_models.sql",
			"0014_chain_evidence.sql",
			"0015_indexer_shards.sql",
			"0016_provider_subscriptions.sql",
			"0017_rpc_control_plane.sql",
			"0018_arbitrum_finality_evidence.sql",
			"0019_user_event_outbox.sql",
			"0020_home_invalidation_outbox.sql",
			"0021_user_operation_lifecycle.sql",
			"0022_ledger_pagination.sql",
			"0023_bundler_capabilities.sql",
			"0024_payment_reconcile_queue.sql",
			"0025_asset_projection_audits.sql",
			"0026_indexer_work_partitions.sql",
			"0027_indexer_consistency.sql",
			"0028_card_interest.sql",
			"0029_gatopago_brand.sql",
		]);
	});

	it("preserves strict tables, foreign keys and integrity columns", async () => {
		const tables = await env.GATOPAGO_DB.prepare("PRAGMA table_list").all<{
			name: string;
			strict: number;
		}>();
		const strictByName = new Map(tables.results.map((row) => [row.name, row.strict]));
		for (const table of [
			"users",
			"payment_links",
			"pending_payments",
			"ledger",
			"webhook_deliveries",
			"crosschain_operations",
			"crosschain_mint_attempts",
			"cron_leases",
			"account_operations",
			"chain_blocks",
			"chain_events",
			"balance_snapshots",
			"balance_refresh_requests",
			"home_state_versions",
			"indexer_shards",
			"indexer_wallet_assignments",
			"provider_subscription_state",
			"rpc_endpoint_health",
			"user_event_outbox",
			"user_operation_receipts",
			"payment_reconcile_requests",
			"bundler_capabilities",
			"balance_projection_baselines",
			"balance_reconciliation_audits",
			"indexer_wallet_registry_outbox",
			"provider_subscription_items",
			"provider_subscription_sync_state",
			"chain_reorg_state",
			"chain_reorg_epoch_guards",
			"chain_reorg_replay_requests",
			"indexer_safety_sweep_state",
			"card_interest",
		]) {
			expect(strictByName.get(table), `${table} must remain STRICT`).toBe(1);
		}

		const ledgerColumns = await env.GATOPAGO_DB.prepare("PRAGMA table_info(ledger)").all<{
			name: string;
		}>();
		expect(ledgerColumns.results.map((row) => row.name)).toEqual(
			expect.arrayContaining([
				"amount_source",
				"amount_raw",
				"chain_id",
				"block_number",
				"block_hash",
				"transaction_index",
				"consistency_level",
				"projection_version",
			]),
		);
		const chainBlockColumns = await env.GATOPAGO_DB.prepare(
			"PRAGMA table_info(chain_blocks)",
		).all<{ name: string }>();
		expect(chainBlockColumns.results.map((row) => row.name)).toEqual(
			expect.arrayContaining(["l1_batch_number", "l1_confirmations"]),
		);

		const linkColumns = await env.GATOPAGO_DB.prepare("PRAGMA table_info(payment_links)").all<{
			name: string;
		}>();
		expect(linkColumns.results.map((row) => row.name)).toEqual(
			expect.arrayContaining(["payment_claim", "payment_claim_expires_at", "payment_claim_tx_hash"]),
		);

		const crosschainColumns = await env.GATOPAGO_DB.prepare(
			"PRAGMA table_info(crosschain_operations)",
		).all<{ name: string }>();
		expect(crosschainColumns.results.map((row) => row.name)).toContain("gatopago_fee");
		expect(crosschainColumns.results.map((row) => row.name)).not.toContain("parmelia_fee");

		await expect(
			env.GATOPAGO_DB.prepare(
				"INSERT INTO passkeys (credential_id, uid, qx, qy) VALUES (?, ?, ?, ?)",
			)
				.bind("orphan", "missing-user", "1", "2")
				.run(),
		).rejects.toThrow();
	});

	it("coalesces an equivalent balance wakeup in real D1", async () => {
		const uid = "runtime-balance-event-coalesce";
		const address = "0x0101010101010101010101010101010101010101";
		const now = new Date().toISOString();
		await env.GATOPAGO_DB.prepare(
			`INSERT INTO users (
				uid, username, wallet_address, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(uid, uid, address, now, now)
			.run();
		await requestBalanceRefresh(env, {
			uid,
			accountAddress: address,
			chainId: 421614,
			reason: "first_stale_read",
			priority: 3,
		});
		await requestBalanceRefresh(env, {
			uid,
			accountAddress: address,
			chainId: 421614,
			reason: "duplicate_stale_read",
			priority: 3,
		});

		const rows = await env.GATOPAGO_DB.prepare(
			`SELECT reason FROM balance_refresh_requests
			 WHERE chain_id = 421614 AND account_address = ?`,
		)
			.bind(address)
			.all<{ reason: string }>();
		expect(rows.results).toEqual([{ reason: "first_stale_read" }]);

		await env.GATOPAGO_DB.batch([
			env.GATOPAGO_DB.prepare(
				"DELETE FROM balance_refresh_requests WHERE uid = ?",
			).bind(uid),
			env.GATOPAGO_DB.prepare("DELETE FROM users WHERE uid = ?").bind(uid),
		]);
	});

	it("lets an urgent confirmed balance refresh preempt a later safety block", async () => {
		const uid = "runtime-balance-priority-preemption";
		const address = "0x0202020202020202020202020202020202020202";
		const now = new Date().toISOString();
		await env.GATOPAGO_DB.prepare(
			`INSERT INTO users (
				uid, username, wallet_address, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(uid, uid, address, now, now)
			.run();

		await requestBalanceRefresh(env, {
			uid,
			accountAddress: address,
			chainId: 421614,
			reason: "autonomous_indexer_safety",
			priority: 1,
			notBeforeBlock: "2000",
		});
		await env.GATOPAGO_DB.prepare(
			`UPDATE balance_refresh_requests
			 SET attempt_count = 7
			 WHERE chain_id = 421614 AND account_address = ?`,
		)
			.bind(address)
			.run();
		await requestBalanceRefresh(env, {
			uid,
			accountAddress: address,
			chainId: 421614,
			reason: "confirmed_user_operation",
			priority: 0,
			notBeforeBlock: "1000",
		});
		await requestBalanceRefresh(env, {
			uid,
			accountAddress: address,
			chainId: 421614,
			reason: "later_safety_sweep",
			priority: 1,
			notBeforeBlock: "3000",
		});

		const row = await env.GATOPAGO_DB.prepare(
			`SELECT reason, priority, required_block, attempt_count
			 FROM balance_refresh_requests
			 WHERE chain_id = 421614 AND account_address = ?`,
		)
			.bind(address)
			.first<{
				reason: string;
				priority: number;
				required_block: number;
				attempt_count: number;
			}>();
		expect(row).toEqual({
			reason: "confirmed_user_operation",
			priority: 0,
			required_block: 1000,
			attempt_count: 0,
		});

		await env.GATOPAGO_DB.batch([
			env.GATOPAGO_DB.prepare(
				"DELETE FROM balance_refresh_requests WHERE uid = ?",
			).bind(uid),
			env.GATOPAGO_DB.prepare("DELETE FROM users WHERE uid = ?").bind(uid),
		]);
	});

	it("keeps wallet shards bounded and stable when a new address sorts first", async () => {
		const now = new Date().toISOString();
		const wallets = Array.from({ length: 5 }, (_, index) => ({
			uid: `runtime-shard-user-${index}`,
			walletAddress: `0x${"aa".repeat(19)}${(index + 10).toString(16).padStart(2, "0")}`,
		}));
		await env.GATOPAGO_DB.batch(
			wallets.map((wallet) =>
				env.GATOPAGO_DB.prepare(
					`INSERT INTO users (
						uid, username, wallet_address, created_at, updated_at
					 ) VALUES (?, ?, ?, ?, ?)`,
				).bind(
					wallet.uid,
					wallet.uid,
					wallet.walletAddress,
					now,
					now,
				),
			),
		);
		const originalAssignments = new Map<string, number>();
		for (const wallet of wallets) {
			const assignment = await assignWalletToStableShard(env, {
				chainId: 421614,
				stream: "runtime-stable-shards",
				uid: wallet.uid,
				walletAddress: wallet.walletAddress,
				maxWallets: 2,
			});
			originalAssignments.set(
				wallet.walletAddress,
				assignment!.shardId,
			);
		}
		const initialShardIds = await listIndexerShardIds(env, {
			chainId: 421614,
			stream: "runtime-stable-shards",
		});
		expect(
			await Promise.all(
				initialShardIds.map(async (shardId) =>
					(await listWalletsForIndexerShard(env, {
						chainId: 421614,
						stream: "runtime-stable-shards",
						shardId,
					})).length,
				),
			),
		).toEqual([2, 2, 1]);

		const added = {
			uid: "runtime-shard-user-added",
			walletAddress: `0x${"aa".repeat(19)}01`,
		};
		await env.GATOPAGO_DB.prepare(
			`INSERT INTO users (
				uid, username, wallet_address, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(added.uid, added.uid, added.walletAddress, now, now)
			.run();
		const second = await assignWalletToStableShard(env, {
			chainId: 421614,
			stream: "runtime-stable-shards",
			uid: added.uid,
			walletAddress: added.walletAddress,
			maxWallets: 2,
		});
		expect(second?.shardId).toBe(2);
		for (const wallet of wallets) {
			const row = await env.GATOPAGO_DB.prepare(
				`SELECT shard_id
				 FROM indexer_wallet_assignments
				 WHERE chain_id = 421614 AND stream = 'runtime-stable-shards'
				   AND account_address = ? AND active = 1`,
			)
				.bind(wallet.walletAddress)
				.first<{ shard_id: number }>();
			expect(row?.shard_id).toBe(
				originalAssignments.get(wallet.walletAddress),
			);
		}

		const third = await assignWalletToStableShard(env, {
			chainId: 421614,
			stream: "runtime-stable-shards",
			uid: added.uid,
			walletAddress: added.walletAddress,
			maxWallets: 2,
		});
		expect(third).toEqual(second);
	});

	it("paginates the ledger without gaps and commits notifications atomically", async () => {
		const uid = "runtime-ledger-page-user";
		const address = "0xabababababababababababababababababababab";
		const createdAt = "2026-07-25T12:00:00.000Z";
		await env.GATOPAGO_DB.prepare(
			`INSERT INTO users (
				uid, username, wallet_address, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(uid, uid, address, createdAt, createdAt)
			.run();

		const entries = Array.from({ length: 5 }, (_, index) => ({
			uid,
			direction: "in" as const,
			kind: "external" as const,
			txHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
			logIndex: index,
			token: "USDC",
			amount: String(index + 1),
			amountRaw: String((index + 1) * 1_000_000),
			decimals: 6,
			chainId: 421614,
			blockNumber: 9_000_000n + BigInt(index),
			blockHash: `0x${(index + 11).toString(16).padStart(64, "0")}`,
			transactionIndex: index,
			consistencyLevel: "safe",
			projectionVersion: 1,
			createdAt,
		}));
		await writeLedgerEntries(env, entries);

		const seen: string[] = [];
		let before: string | null = null;
		do {
			const page = await listLedgerPageByUid(env, uid, {
				limit: 2,
				before,
			});
			seen.push(...page.entries.map((entry) => entry.id!));
			before = page.nextCursor;
		} while (before);
		expect(seen).toHaveLength(5);
		expect(new Set(seen).size).toBe(5);

		const depositEntry = {
			...entries[0],
			txHash: `0x${"de".repeat(32)}`,
			logIndex: 99,
		};
		const depositEvent = {
			dedupeKey: "runtime-deposit-notification",
			uid,
			eventType: "activity.deposit_received",
			payload: {
				title: "Deposit received",
				body: "Open GatoPago to see it.",
				link: "/",
			},
			priority: 1 as const,
		};
		expect(
			await writeLedgerEntries(env, [depositEntry], {
				userEvents: [depositEvent],
			}),
		).toEqual([true]);
		expect(
			await writeLedgerEntries(env, [depositEntry], {
				userEvents: [depositEvent],
			}),
		).toEqual([false]);
		const depositEffects = await env.GATOPAGO_DB.prepare(
			`SELECT COUNT(*) AS count FROM user_event_outbox
			 WHERE dedupe_key = ?`,
		)
			.bind(depositEvent.dedupeKey)
			.first<{ count: number }>();
		expect(depositEffects?.count).toBe(1);

		const rolledBackHash = `0x${"ef".repeat(32)}`;
		await expect(
			writeLedgerEntries(
				env,
				[{ ...depositEntry, txHash: rolledBackHash, logIndex: 100 }],
				{
					userEvents: [{
						...depositEvent,
						dedupeKey: "runtime-invalid-notification",
						uid: "runtime-user-does-not-exist",
					}],
				},
			),
		).rejects.toThrow();
		const rolledBack = await env.GATOPAGO_DB.prepare(
			`SELECT COUNT(*) AS count FROM ledger WHERE tx_hash = ?`,
		)
			.bind(rolledBackHash)
			.first<{ count: number }>();
		expect(rolledBack?.count).toBe(0);
	});

	it("coordinates the first 429 and exactly one half-open RPC probe in D1", async () => {
		const endpointKey = "read:runtime:rate-limited";
		await rpcControlTest.recordFailure(env, {
			endpointKey,
			role: "read",
			providerAlias: "runtime-provider",
			errorCode: "RATE_LIMITED",
			latencyMs: 25,
		});
		const opened = await env.GATOPAGO_DB.prepare(
			`SELECT circuit_state, consecutive_failures, opened_until
			 FROM rpc_endpoint_health WHERE endpoint_key = ?`,
		)
			.bind(endpointKey)
			.first<{
				circuit_state: string;
				consecutive_failures: number;
				opened_until: string | null;
			}>();
		expect(opened).toMatchObject({
			circuit_state: "open",
			consecutive_failures: 1,
		});
		expect(opened?.opened_until).not.toBeNull();

		await env.GATOPAGO_DB.prepare(
			`UPDATE rpc_endpoint_health SET opened_until = ?
			 WHERE endpoint_key = ?`,
		)
			.bind("2020-01-01T00:00:00.000Z", endpointKey)
			.run();
		expect(
			await rpcControlTest.claimHalfOpenProbe(env, endpointKey),
		).toBe("claimed");
		expect(
			await rpcControlTest.claimHalfOpenProbe(env, endpointKey),
		).toBe("busy");
	});

	it("projects an exact USDC delta from an RPC baseline idempotently", async () => {
		const uid = "runtime-event-balance-user";
		const address =
			"0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd" as const;
		const chainId = 421614;
		const now = new Date().toISOString();
		// Keep this fixture below the later reorg fixture's ancestor because the
		// runtime suite intentionally shares one D1 database sequentially.
		const block200 = 8_700_200n;
		const block201 = block200 + 1n;
		const hash200 = `0x${"31".repeat(32)}` as const;
		const hash201 = `0x${"32".repeat(32)}` as const;
		const txHash = `0x${"33".repeat(32)}` as const;
		await env.GATOPAGO_DB.prepare(
			`INSERT INTO users (
				uid, username, wallet_address, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(uid, uid, address, now, now)
			.run();
		await upsertBalanceSnapshots(env, [{
			uid,
			accountAddress: address,
			chainId,
			asset: "USDC",
			balanceRaw: 100_000_000n,
			decimals: 6,
			blockNumber: block200,
			blockHash: hash200,
			consistencyLevel: "safe",
			projectionStrategy: "events_plus_rpc",
			projectionVersion: 1,
			observedAt: now,
			reconciledAt: now,
			source: "rpc_reconcile",
		}]);
		const event = {
			txHash,
			logIndex: 1,
			eventKind: "erc20.Transfer",
			blockNumber: block201,
			blockHash: hash201,
			transactionIndex: 0,
			contractAddress:
				"0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d" as const,
			payload: { value: "10000000" },
			source: "runtime_fixture",
			observedAt: now,
			accounts: [{
				uid,
				accountAddress: address,
				asset: "USDC",
				role: "to" as const,
				deltaRaw: 10_000_000n,
			}],
		};
		const block = {
			chainId,
			blockNumber: block201,
			blockHash: hash201,
			parentHash: hash200,
			timestamp: 1_800_000_101n,
			consistencyLevel: "safe" as const,
			source: "runtime_fixture",
			observedAt: now,
		};
		await journalBlockEvents(env, {
			stream: "runtime-event-projection-stream",
			block,
			events: [event],
		});
		await projectBalanceDeltas(env, { block, events: [event] });
		await projectBalanceDeltas(env, { block, events: [event] });

		const projected = await env.GATOPAGO_DB.prepare(
			`SELECT balance_raw, block_number, block_hash, source
			 FROM balance_snapshots
			 WHERE chain_id = ? AND account_address = ? AND asset = 'USDC'`,
		)
			.bind(chainId, address)
			.first<{
				balance_raw: string;
				block_number: number | string;
				block_hash: string;
				source: string;
			}>();
		expect(projected).toMatchObject({
			balance_raw: "110000000",
			block_number: Number(block201),
			block_hash: hash201,
			source: "event_projection",
		});
	});

	it("dedupes journal projections and rolls a reorg back before replay", async () => {
		const uid = "runtime-reorg-user";
		const address = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const now = new Date().toISOString();
		await env.GATOPAGO_DB.prepare(
			`INSERT INTO users (
				uid, username, wallet_address, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(uid, uid, address, now, now)
			.run();

		const chainId = 421614;
		const stream = "runtime-reorg-stream";
		const siblingStream = `userops:${chainId}:shard:77`;
		const block100 = 8_800_100n;
		const block101 = 8_800_101n;
		const hash99 = `0x${"09".repeat(32)}` as const;
		const hash100 = `0x${"10".repeat(32)}` as const;
		const oldHash101 = `0x${"11".repeat(32)}` as const;
		const newHash101 = `0x${"12".repeat(32)}` as const;
		const txHash = `0x${"21".repeat(32)}` as const;
		const contract = "0xcccccccccccccccccccccccccccccccccccccccc" as const;
		const baseEvent = {
			txHash,
			logIndex: 3,
			eventKind: "erc20.Transfer",
			blockNumber: block101,
			blockHash: oldHash101,
			transactionIndex: 2,
			contractAddress: contract,
			payload: { value: "1000000" },
			source: "runtime_fixture",
			observedAt: now,
			accounts: [{
				uid,
				accountAddress: address as `0x${string}`,
				asset: "USDC",
				role: "to" as const,
				deltaRaw: 1_000_000n,
			}],
		};
		await journalBlockEvents(env, {
			stream,
			block: {
				chainId,
				blockNumber: block100,
				blockHash: hash100,
				parentHash: hash99,
				timestamp: 1_800_000_000n,
				consistencyLevel: "safe",
				source: "runtime_fixture",
				observedAt: now,
			},
			events: [],
		});
		const firstJournal = await journalBlockEvents(env, {
			stream,
			block: {
				chainId,
				blockNumber: block101,
				blockHash: oldHash101,
				parentHash: hash100,
				timestamp: 1_800_000_001n,
				consistencyLevel: "safe",
				source: "runtime_fixture",
				observedAt: now,
			},
			events: [baseEvent],
		});
		const duplicateJournal = await journalBlockEvents(env, {
			stream,
			block: {
				chainId,
				blockNumber: block101,
				blockHash: oldHash101,
				parentHash: hash100,
				timestamp: 1_800_000_001n,
				consistencyLevel: "safe",
				source: "runtime_fixture",
				observedAt: now,
			},
			events: [baseEvent],
		});
		await journalBlockEvents(env, {
			stream: siblingStream,
			block: {
				chainId,
				blockNumber: block101,
				blockHash: oldHash101,
				parentHash: hash100,
				timestamp: 1_800_000_001n,
				consistencyLevel: "safe",
				source: "runtime_fixture",
				observedAt: now,
			},
			events: [],
		});
		await env.GATOPAGO_DB.batch([
			env.GATOPAGO_DB.prepare(
				`INSERT INTO sync_state (key, last_block, updated_at)
				 VALUES (?, ?, ?)`,
			).bind(
				`transfers:${chainId}:runtime:from:shard:77`,
				block101.toString(),
				now,
			),
			env.GATOPAGO_DB.prepare(
				`INSERT INTO sync_state (key, last_block, updated_at)
				 VALUES (?, ?, ?)`,
			).bind(
				`userops:${chainId}:shard:77`,
				block101.toString(),
				now,
			),
		]);
		expect(firstJournal.insertedEventIds.size).toBe(1);
		expect(duplicateJournal.duplicateEventIds.size).toBe(1);
		await projectBalanceDeltas(env, {
			block: {
				chainId,
				blockNumber: block101,
				blockHash: oldHash101,
				parentHash: hash100,
				timestamp: 1_800_000_001n,
				consistencyLevel: "safe",
				source: "runtime_fixture",
				observedAt: now,
			},
			events: [baseEvent],
		});
		await projectBalanceDeltas(env, {
			block: {
				chainId,
				blockNumber: block101,
				blockHash: oldHash101,
				parentHash: hash100,
				timestamp: 1_800_000_001n,
				consistencyLevel: "safe",
				source: "runtime_fixture",
				observedAt: now,
			},
			events: [baseEvent],
		});
		const deltaCount = await env.GATOPAGO_DB.prepare(
			`SELECT COUNT(*) AS count FROM balance_projection_deltas
			 WHERE event_id = ?`,
		)
			.bind(`${chainId}:${txHash.toLowerCase()}:3:erc20.Transfer`)
			.first<{ count: number }>();
		expect(deltaCount?.count).toBe(1);

		await upsertBalanceSnapshots(env, [{
			uid,
			accountAddress: address,
			chainId,
			asset: "USDC",
			balanceRaw: 1_000_000n,
			decimals: 6,
			blockNumber: block101,
			blockHash: oldHash101,
			consistencyLevel: "safe",
			projectionStrategy: "rpc_only",
			projectionVersion: 1,
			observedAt: now,
			reconciledAt: now,
			source: "runtime_fixture",
		}]);
		await writeLedgerEntries(env, [{
			uid,
			direction: "in",
			kind: "external",
			txHash,
			logIndex: 3,
			token: "USDC",
			amount: "1",
			amountRaw: "1000000",
			decimals: 6,
			chainId,
			blockNumber: block101,
			blockHash: oldHash101,
			transactionIndex: 2,
			consistencyLevel: "safe",
			projectionVersion: 1,
			createdAt: now,
		}]);

		const recovery = await verifyAndRecoverStream(env, {
			getBlock: async ({ blockNumber }) => ({
				hash: blockNumber === block101 ? newHash101 : hash100,
			}),
		}, { chainId, stream });
		expect(recovery).toMatchObject({
			status: "recovered",
			checkpoint: block100,
			depth: 1n,
			affectedEvents: 1,
			affectedAccounts: 1,
			affectedStreams: 2,
			reorgEpoch: 1,
		});
		const rewoundStreams = await env.GATOPAGO_DB.prepare(
			`SELECT stream, block_number, block_hash, reorg_epoch
			 FROM chain_stream_checkpoints
			 WHERE chain_id = ? AND stream IN (?, ?)
			 ORDER BY stream`,
		)
			.bind(chainId, stream, siblingStream)
			.all<{
				stream: string;
				block_number: number | string;
				block_hash: string;
				reorg_epoch: number;
			}>();
		expect(rewoundStreams.results).toEqual([
			{
				stream,
				block_number: Number(block100),
				block_hash: hash100,
				reorg_epoch: 1,
			},
			{
				stream: siblingStream,
				block_number: Number(block100),
				block_hash: hash100,
				reorg_epoch: 1,
			},
		]);
		const rewoundCursors = await env.GATOPAGO_DB.prepare(
			`SELECT key, last_block FROM sync_state
			 WHERE key IN (?, ?) ORDER BY key`,
		)
			.bind(
				`transfers:${chainId}:runtime:from:shard:77`,
				`userops:${chainId}:shard:77`,
			)
			.all<{ key: string; last_block: string }>();
		expect(
			rewoundCursors.results.map((row) => ({
				...row,
				last_block: String(row.last_block),
			})),
		).toEqual([
			{
				key: `transfers:${chainId}:runtime:from:shard:77`,
				last_block: block100.toString(),
			},
			{
				key: `userops:${chainId}:shard:77`,
				last_block: block100.toString(),
			},
		]);
		const replayRequests = await env.GATOPAGO_DB.prepare(
			`SELECT stream, common_ancestor_number, reorg_epoch
			 FROM chain_reorg_replay_requests
			 WHERE chain_id = ? ORDER BY stream`,
		)
			.bind(chainId)
			.all<{
				stream: string;
				common_ancestor_number: number | string;
				reorg_epoch: number;
			}>();
		expect(replayRequests.results).toHaveLength(2);
		expect(
			replayRequests.results.map((row) => ({
				...row,
				common_ancestor_number: String(
					row.common_ancestor_number,
				),
			})),
		).toEqual([
			{
				stream,
				common_ancestor_number: block100.toString(),
				reorg_epoch: 1,
			},
			{
				stream: siblingStream,
				common_ancestor_number: block100.toString(),
				reorg_epoch: 1,
			},
		]);
		await expect(
			journalBlockEvents(env, {
				stream,
				expectedReorgEpoch: 0,
				block: {
					chainId,
					blockNumber: block101 + 1n,
					blockHash: `0x${"31".repeat(32)}`,
					parentHash: newHash101,
					timestamp: 1_800_000_003n,
					consistencyLevel: "safe",
					source: "runtime_fixture",
					observedAt: now,
				},
				events: [],
			}),
		).rejects.toThrow();
		const transferCursorKey =
			`transfers:${chainId}:runtime:from:shard:77`;
		await expect(
			setSyncCursor(env, transferCursorKey, block101 + 1n, {
				chainId,
				expectedReorgEpoch: 0,
			}),
		).rejects.toThrow();
		expect(await getSyncCursor(env, transferCursorKey)).toBe(block100);
		expect(await listBalanceSnapshots(env, uid, chainId)).toEqual([]);
		const orphaned = await env.GATOPAGO_DB.prepare(
			`SELECT canonical FROM ledger
			 WHERE uid = ? AND tx_hash = ? AND log_index = ?`,
		)
			.bind(uid, txHash.toLowerCase(), 3)
			.first<{ canonical: number }>();
		expect(orphaned?.canonical).toBe(0);

		const replayEvent = { ...baseEvent, blockHash: newHash101 };
		await journalBlockEvents(env, {
			stream,
			block: {
				chainId,
				blockNumber: block101,
				blockHash: newHash101,
				parentHash: hash100,
				timestamp: 1_800_000_002n,
				consistencyLevel: "safe",
				source: "runtime_fixture",
				observedAt: now,
			},
			events: [replayEvent],
		});
		await projectBalanceDeltas(env, {
			block: {
				chainId,
				blockNumber: block101,
				blockHash: newHash101,
				parentHash: hash100,
				timestamp: 1_800_000_002n,
				consistencyLevel: "safe",
				source: "runtime_fixture",
				observedAt: now,
			},
			events: [replayEvent],
		});
		await writeLedgerEntries(env, [{
			uid,
			direction: "in",
			kind: "external",
			txHash,
			logIndex: 3,
			token: "USDC",
			amount: "1",
			amountRaw: "1000000",
			decimals: 6,
			chainId,
			blockNumber: block101,
			blockHash: newHash101,
			transactionIndex: 2,
			consistencyLevel: "safe",
			projectionVersion: 1,
			createdAt: now,
		}]);
		const replayed = await env.GATOPAGO_DB.prepare(
			`SELECT canonical, block_hash FROM ledger
			 WHERE uid = ? AND tx_hash = ? AND log_index = ?`,
		)
			.bind(uid, txHash.toLowerCase(), 3)
			.first<{ canonical: number; block_hash: string }>();
		expect(replayed).toEqual({
			canonical: 1,
			block_hash: newHash101.toLowerCase(),
		});
		await env.GATOPAGO_DB.prepare(
			`DELETE FROM chain_reorg_replay_requests WHERE chain_id = ?`,
		)
			.bind(chainId)
			.run();
	});

	it("retains UserOperation re-inclusions and queues canonical reconciliation", async () => {
		const now = new Date().toISOString();
		const uid = "runtime-userop-user";
		const sender =
			"0xdededededededededededededededededededede" as const;
		const userOpHash = `0x${"a1".repeat(32)}` as const;
		const chainId = 421614;
		await env.GATOPAGO_DB.prepare(
			`INSERT INTO users (
				uid, username, wallet_address, created_at, updated_at
			 ) VALUES (?, ?, ?, ?, ?)`,
		)
			.bind(uid, uid, sender, now, now)
			.run();
		await createPendingPayment(env, {
			userOpHash,
			uid,
			linkId: null,
			wallet: sender,
			senderAddress: sender,
			amount: "0",
			currency: "PASSKEY_ADD",
			userOp: {},
			submissionTransport: "bundler",
		});
		expect(await claimPendingForSubmit(env, userOpHash)).toBe(true);

		const journalOccurrence = async (input: {
			blockNumber: bigint;
			blockHash: `0x${string}`;
			parentHash: `0x${string}`;
			txHash: `0x${string}`;
			logIndex: number;
		}) => {
			const eventKind = "entrypoint.UserOperationEvent" as const;
			await journalBlockEvents(env, {
				stream: `runtime-userops:${chainId}`,
				block: {
					chainId,
					blockNumber: input.blockNumber,
					blockHash: input.blockHash,
					parentHash: input.parentHash,
					timestamp: 1_800_001_000n + input.blockNumber,
					consistencyLevel: "safe",
					source: "runtime_fixture",
					observedAt: now,
				},
				events: [{
					txHash: input.txHash,
					logIndex: input.logIndex,
					eventKind,
					blockNumber: input.blockNumber,
					blockHash: input.blockHash,
					transactionIndex: 1,
					contractAddress:
						"0x433709009b8330fda32311df1c2afa402ed8d009",
					payload: {
						userOpHash,
						sender,
						nonce: "7",
						success: true,
						actualGasCost: "100",
						actualGasUsed: "90",
					},
					source: "runtime_fixture",
					observedAt: now,
					accounts: [{
						uid,
						accountAddress: sender,
						asset: "ACCOUNT",
						role: "account",
					}],
				}],
				userOperationReceipts: [{
					userOpHash,
					txHash: input.txHash,
					logIndex: input.logIndex,
					eventKind,
					blockNumber: input.blockNumber,
					blockHash: input.blockHash,
					transactionIndex: 1,
					sender,
					nonce: 7n,
					success: true,
					actualGasCost: 100n,
					actualGasUsed: 90n,
					source: "runtime_fixture",
					observedAt: now,
				}],
			});
		};

		const firstBlockHash = `0x${"b1".repeat(32)}` as const;
		await journalOccurrence({
			blockNumber: 9_100_001n,
			blockHash: firstBlockHash,
			parentHash: `0x${"b0".repeat(32)}`,
			txHash: `0x${"c1".repeat(32)}`,
			logIndex: 4,
		});
		const queued = await env.GATOPAGO_DB.prepare(
			`SELECT status, priority
			 FROM payment_reconcile_requests
			 WHERE user_op_hash = ?`,
		)
			.bind(userOpHash)
			.first<{ status: string; priority: number }>();
		expect(queued).toEqual({ status: "pending", priority: 0 });

		// Model a reorg before the same operation is included in a new bundle.
		await env.GATOPAGO_DB.batch([
			env.GATOPAGO_DB.prepare(
				`UPDATE chain_events SET canonical = 0
				 WHERE chain_id = ? AND block_hash = ?`,
			).bind(chainId, firstBlockHash),
			env.GATOPAGO_DB.prepare(
				`UPDATE chain_blocks SET canonical = 0
				 WHERE chain_id = ? AND block_hash = ?`,
			).bind(chainId, firstBlockHash),
			env.GATOPAGO_DB.prepare(
				`UPDATE user_operation_receipts SET canonical = 0
				 WHERE chain_id = ? AND block_hash = ?`,
			).bind(chainId, firstBlockHash),
		]);
		await journalOccurrence({
			blockNumber: 9_100_002n,
			blockHash: `0x${"b2".repeat(32)}`,
			parentHash: `0x${"b0".repeat(32)}`,
			txHash: `0x${"c2".repeat(32)}`,
			logIndex: 2,
		});
		const occurrences = await env.GATOPAGO_DB.prepare(
			`SELECT tx_hash, canonical
			 FROM user_operation_receipts
			 WHERE chain_id = ? AND user_op_hash = ?
			 ORDER BY block_number`,
		)
			.bind(chainId, userOpHash)
			.all<{ tx_hash: string; canonical: number }>();
		expect(occurrences.results).toEqual([
			{ tx_hash: `0x${"c1".repeat(32)}`, canonical: 0 },
			{ tx_hash: `0x${"c2".repeat(32)}`, canonical: 1 },
		]);
	});

	it("enforces one unresolved account operation per user and kind", async () => {
		const createdAt = new Date().toISOString();
		const base = {
			uid: "runtime-operation-user",
			kind: "recovery_cancel" as const,
			txHash: `0x${"31".repeat(32)}` as `0x${string}`,
			rawTransaction: `0x${"41".repeat(64)}` as `0x${string}`,
			signerAddress: "0x00000000000000000000000000000000000000aa" as `0x${string}`,
			nonce: 1,
			metadata: { walletAddress: "0x00000000000000000000000000000000000000bb" },
			createdAt,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		};
		expect(await createAccountOperation(env, { id: "runtime-operation-1", ...base })).toBe(true);
		expect(await createAccountOperation(env, {
			id: "runtime-operation-2",
			...base,
			txHash: `0x${"32".repeat(32)}`,
		})).toBe(false);

		expect(await finishAccountOperation(env, "runtime-operation-1", "needs_review", {
			errorCode: "TX_STUCK",
		})).toBe(true);
		expect((await getActiveAccountOperation(env, base.uid, base.kind))?.status).toBe("needs_review");
		await expect(withSignerLease(
			env,
			{ chainId: 421614, signerAddress: base.signerAddress },
			async () => undefined,
		)).rejects.toBeInstanceOf(SignerLeaseBusyError);
		const blockedHealth = await exports.default.fetch(new Request("https://worker.test/health"));
		expect(blockedHealth.status).toBe(503);
		const blockedHealthPayload = await blockedHealth.json<Record<string, unknown>>();
		expect(blockedHealthPayload).toMatchObject({
			status: "not_ready",
			issueCount: expect.any(Number),
		});
		expect(blockedHealthPayload).not.toHaveProperty("issues");
		expect(blockedHealthPayload).not.toHaveProperty("rpc");
		expect(Number(blockedHealthPayload.issueCount)).toBeGreaterThan(0);
		expect(await createAccountOperation(env, {
			id: "runtime-operation-3",
			...base,
			txHash: `0x${"33".repeat(32)}`,
		})).toBe(false);
		await env.GATOPAGO_DB.prepare("DELETE FROM account_operations WHERE id = ?")
			.bind("runtime-operation-1")
			.run();
	});

	it("serves readiness and enforces authentication through workerd", async () => {
		const live = await exports.default.fetch(new Request("https://worker.test/health/live"));
		expect(live.status).toBe(200);
		expect(live.headers.get("Cache-Control")).toBe("no-store");
		expect(live.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
		expect(live.headers.get("Cross-Origin-Resource-Policy")).toBe("cross-origin");
		expect(live.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(live.headers.get("X-Frame-Options")).toBe("DENY");
		expect(await live.json()).toEqual({ status: "ok" });

		const health = await exports.default.fetch(new Request("https://worker.test/health"));
		expect(health.status).toBe(200);
		expect(health.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
		expect(health.headers.get("Cache-Control")).toBe("no-store");
		expect(await health.json()).toEqual({
			status: "ok",
			network: "arbitrum-sepolia",
			issueCount: 0,
			warningCount: 0,
		});
		const opsHealth = await exports.default.fetch(new Request("https://worker.test/health/ops"));
		expect(opsHealth.status).toBe(404);

		const protectedResponse = await exports.default.fetch(
			new Request("https://worker.test/user/profile", {
				headers: { "X-Request-Id": "runtime-request-123" },
			}),
		);
		expect(protectedResponse.status).toBe(401);
		expect(protectedResponse.headers.get("X-Request-Id")).toBe("runtime-request-123");
		expect(await protectedResponse.json()).toMatchObject({
			error_code: "UNAUTHENTICATED",
			requestId: "runtime-request-123",
		});
	});

	it("enforces CORS and Web Crypto behavior through workerd", async () => {
		const response = await exports.default.fetch(
			new Request("https://worker.test/", {
				headers: { Origin: "https://app.parmelia.me" },
			}),
		);
		expect(response.headers.get("Access-Control-Allow-Origin")).toBe("https://app.parmelia.me");
		expect(response.headers.get("Access-Control-Expose-Headers")).toContain("X-Request-Id");
		expect(await hmacSha256Hex("secret", "message")).toBe(
			"8b5f48702995c1598c573db1e21866a9b825d4a794d169d7060a03605796360b",
		);
	});

	it("enforces the request body limit before route processing", async () => {
		const response = await exports.default.fetch(
			new Request("https://worker.test/links", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ payload: "x".repeat(65 * 1024) }),
			}),
		);
		expect(response.status).toBe(413);
		expect(await response.json()).toMatchObject({ error_code: "PAYLOAD_TOO_LARGE" });
	});

	it("reads a migrated D1 payment link through the HTTP route", async () => {
		const now = new Date().toISOString();
		await env.GATOPAGO_DB.batch([
			env.GATOPAGO_DB.prepare(
				"INSERT INTO users (uid, username, wallet_address, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			).bind("runtime-user", "runtime_user", "0x0000000000000000000000000000000000000001", now, now),
			env.GATOPAGO_DB.prepare(
				`INSERT INTO payment_links
				 (id, owner_uid, wallet_address, amount, currency, reference, status, created_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
			).bind(
				"runtime-link",
				"runtime-user",
				"0x0000000000000000000000000000000000000001",
				"12.50",
				"USDC",
				"Runtime integration",
				now,
			),
		]);

		const response = await exports.default.fetch(new Request("https://worker.test/links/runtime-link"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			id: "runtime-link",
			ownerUid: "runtime-user",
			amount: "12.50",
			status: "pending",
		});
	});

	it("repairs a CCTP hand-off stranded after broadcast", async () => {
		const now = new Date().toISOString();
		const opId = `0x${"42".repeat(32)}`;
		const txHash = `0x${"24".repeat(32)}`;
		await createCrosschainOp(env, {
			opId,
			uid: "runtime-user",
			direction: "outbound",
			provider: "cctp",
			cctpMode: "standard",
			sourceChainId: 421614,
			destinationChainId: 84532,
			sourceDomain: 3,
			destinationDomain: 6,
			destinationCaller: null,
			sourceTxHash: null,
			destinationTxHash: null,
			messageNonce: null,
			messageBytes: null,
			attestation: null,
			token: "USDC",
			amountIn: "12500000",
			gatoPagoFee: "0",
			maxFee: "0",
			minFinalityThreshold: 1000,
			cctpFeeEstimated: null,
			amountOutExpected: "12500000",
			recipient: "0x0000000000000000000000000000000000000002",
			status: "quoted",
			statusDetail: null,
			createdAt: now,
			updatedAt: now,
			completedAt: null,
		});

		const pending: PendingPaymentRecord = {
			userOpHash: `0x${"11".repeat(32)}`,
			uid: "runtime-user",
			linkId: null,
			wallet: "0x0000000000000000000000000000000000000002",
			senderAddress: "0x0000000000000000000000000000000000000001",
			amount: "12.5",
			currency: "CROSSCHAIN",
			userOp: {},
			meta: { opId, amountIn: "12500000", recipient: "0x0000000000000000000000000000000000000002" },
			status: "submitting",
			submittedTxHash: null,
			submissionTransport: "self",
			submittedAt: null,
			submissionAttemptCount: 1,
			lastSubmissionErrorCode: null,
			createdAt: now,
			expiresAt: new Date(Date.now() + 600_000).toISOString(),
		};

		await settlePayment(env, pending, txHash);

		expect(await getCrosschainOpById(env, opId)).toMatchObject({
			status: "submitted",
			sourceTxHash: txHash,
		});
		const ledger = await env.GATOPAGO_DB.prepare(
			"SELECT amount, amount_source FROM ledger WHERE uid = ? AND tx_hash = ?",
		)
			.bind("runtime-user", txHash)
			.first<{ amount: string; amount_source: string }>();
		expect(ledger).toEqual({ amount: "12.5", amount_source: "executed" });

		await updateCrosschainOp(env, opId, { status: "waiting_attestation" });
		await settlePayment(env, pending, txHash);
		expect(await getCrosschainOpById(env, opId)).toMatchObject({
			status: "waiting_attestation",
			sourceTxHash: txHash,
		});
	});

	it("keeps a named work lease exclusive and owner-bound", async () => {
		const key = "test:owner-bound-lease";
		const firstOwner = await acquireLease(env, key, 60_000);
		expect(firstOwner).toBeTypeOf("string");
		expect(await acquireLease(env, key, 60_000)).toBeNull();
		expect(await renewLease(env, key, "not-the-owner", 120_000)).toBe(false);
		expect(await renewLease(env, key, firstOwner!, 120_000)).toBe(true);

		await releaseLease(env, key, "not-the-owner");
		expect(await acquireLease(env, key, 60_000)).toBeNull();

		await releaseLease(env, key, firstOwner!);
		const secondOwner = await acquireLease(env, key, 60_000);
		expect(secondOwner).toBeTypeOf("string");
		expect(secondOwner).not.toBe(firstOwner);
		await releaseLease(env, key, secondOwner!);
	});
});

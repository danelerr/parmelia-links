import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";

type CountRow = {
	payment_reconcile_dead: number;
	payment_reconcile_active: number;
	user_event_dead: number;
	user_event_active: number;
	balance_refresh_active: number;
	balance_refresh_failed: number;
	balance_projection_drift: number;
	account_operation_active: number;
	crosschain_active: number;
	webhook_delivery_active: number;
	router_intent_active: number;
	indexer_registry_active: number;
	indexer_registry_failed: number;
	provider_subscription_active: number;
	provider_subscription_failed: number;
	reorg_replay_active: number;
	reorg_replay_failed: number;
	indexer_active_shards: number;
};

type StreamRow = {
	stream: string;
	block_number: number | string;
	updated_at: string;
};

export type OperationalHealthSummary = {
	queues: {
		paymentReconcileActive: number;
		paymentReconcileDead: number;
		userEventActive: number;
		userEventDead: number;
		balanceRefreshActive: number;
		balanceRefreshFailed: number;
		balanceProjectionDrift: number;
		accountOperationActive: number;
		crosschainActive: number;
		webhookDeliveryActive: number;
		routerIntentActive: number;
		indexerRegistryActive: number;
		indexerRegistryFailed: number;
		providerSubscriptionActive: number;
		providerSubscriptionFailed: number;
		reorgReplayActive: number;
		reorgReplayFailed: number;
		indexerActiveShards: number;
	};
	streams: Array<{
		name: string;
		blockNumber: string;
		ageSeconds: number | null;
	}>;
};

export async function getOperationalHealth(
	env: Bindings,
): Promise<{
	summary: OperationalHealthSummary;
	warnings: string[];
}> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const [counts, streams] = await Promise.all([
		env.PARMELIA_DB.prepare(
			`SELECT
				(SELECT COUNT(*) FROM payment_reconcile_requests
				 WHERE status = 'dead') AS payment_reconcile_dead,
				(SELECT COUNT(*) FROM payment_reconcile_requests
				 WHERE status IN ('pending', 'processing', 'failed'))
				 AS payment_reconcile_active,
				(SELECT COUNT(*) FROM user_event_outbox
				 WHERE status = 'dead') AS user_event_dead,
				(SELECT COUNT(*) FROM user_event_outbox
				 WHERE status IN ('pending', 'processing', 'failed'))
				 AS user_event_active,
				(SELECT COUNT(*) FROM balance_refresh_requests
				 WHERE status IN ('pending', 'processing', 'failed'))
				 AS balance_refresh_active,
				(SELECT COUNT(*) FROM balance_refresh_requests
				 WHERE status = 'failed') AS balance_refresh_failed,
				(SELECT COUNT(*) FROM balance_reconciliation_audits
				 WHERE outcome = 'drift') AS balance_projection_drift,
				(SELECT COUNT(*) FROM account_operations
				 WHERE status IN ('prepared', 'submitted'))
				 AS account_operation_active,
				(SELECT COUNT(*) FROM crosschain_operations
				 WHERE status IN ('submitted', 'waiting_attestation', 'minting', 'recoverable'))
				 AS crosschain_active,
				(SELECT COUNT(*) FROM webhook_deliveries
				 WHERE status IN ('pending', 'processing'))
				 AS webhook_delivery_active,
				(SELECT COUNT(*) FROM payment_intents
				 WHERE status = 'awaiting_payment' AND expires_at > ?)
				 AS router_intent_active,
				(SELECT COUNT(*) FROM indexer_wallet_registry_outbox
				 WHERE status IN ('pending', 'failed'))
				 AS indexer_registry_active,
				(SELECT COUNT(*) FROM indexer_wallet_registry_outbox
				 WHERE status = 'failed')
				 AS indexer_registry_failed,
				(SELECT COUNT(*) FROM provider_subscription_state
				 WHERE status IN ('pending', 'failed'))
				 AS provider_subscription_active,
				(SELECT COUNT(*) FROM provider_subscription_state
				 WHERE status = 'failed')
				 AS provider_subscription_failed,
				(SELECT COUNT(*) FROM chain_reorg_replay_requests
				 WHERE status IN ('pending', 'failed'))
				 AS reorg_replay_active,
				(SELECT COUNT(*) FROM chain_reorg_replay_requests
				 WHERE status = 'failed')
				 AS reorg_replay_failed,
				(SELECT COUNT(*)
				 FROM indexer_shards s
				 WHERE s.chain_id = ?
				   AND s.status = 'active'
				   AND EXISTS (
				     SELECT 1
				     FROM indexer_wallet_assignments a
				     WHERE a.chain_id = s.chain_id
				       AND a.stream = s.stream
				       AND a.shard_id = s.shard_id
				       AND a.active = 1
				   ))
				 AS indexer_active_shards`,
		)
			.bind(new Date().toISOString(), network.chainId)
			.first<CountRow>(),
		env.PARMELIA_DB.prepare(
			`SELECT stream, block_number, updated_at
			 FROM chain_stream_checkpoints
			 WHERE chain_id = ?
			   AND (
				stream = ?
				OR stream LIKE ?
				OR stream LIKE ?
				OR stream LIKE ?
			   )
			 ORDER BY stream`,
		)
			.bind(
				network.chainId,
				`router:${network.chainId}`,
				`erc20_transfers:${network.chainId}:%`,
				`userops:${network.chainId}:%`,
				`recovery:${network.chainId}:%`,
			)
			.all<StreamRow>(),
	]);
	if (!counts) throw new Error("Operational health count query returned no row");

	const now = Date.now();
	const streamViews = streams.results.map((row) => {
		const updatedAt = Date.parse(row.updated_at);
		return {
			name: row.stream,
			blockNumber: String(row.block_number),
			ageSeconds: Number.isFinite(updatedAt)
				? Math.max(0, Math.floor((now - updatedAt) / 1_000))
				: null,
		};
	});
	const warnings: string[] = [];
	if (counts.payment_reconcile_dead > 0) {
		warnings.push("payment_reconcile_dead");
	}
	if (counts.user_event_dead > 0) warnings.push("user_event_outbox_dead");
	if (counts.balance_refresh_failed > 0) {
		warnings.push("balance_refresh_failed");
	}
	if (counts.balance_projection_drift > 0) {
		warnings.push("balance_projection_drift");
	}
	if (counts.indexer_registry_failed > 0) {
		warnings.push("indexer_wallet_registry_failed");
	}
	if (counts.provider_subscription_failed > 0) {
		warnings.push("provider_subscription_failed");
	}
	if (counts.reorg_replay_failed > 0) {
		warnings.push("chain_reorg_replay_failed");
	}
	// Stream age is informational in an event-driven indexer. With no relevant
	// chain event a checkpoint is expected to stay unchanged indefinitely; age
	// alone no longer means the Worker is unhealthy.

	return {
		summary: {
			queues: {
				paymentReconcileActive: counts.payment_reconcile_active,
				paymentReconcileDead: counts.payment_reconcile_dead,
				userEventActive: counts.user_event_active,
				userEventDead: counts.user_event_dead,
				balanceRefreshActive: counts.balance_refresh_active,
				balanceRefreshFailed: counts.balance_refresh_failed,
				balanceProjectionDrift: counts.balance_projection_drift,
				accountOperationActive: counts.account_operation_active,
				crosschainActive: counts.crosschain_active,
				webhookDeliveryActive: counts.webhook_delivery_active,
				routerIntentActive: counts.router_intent_active,
				indexerRegistryActive: counts.indexer_registry_active,
				indexerRegistryFailed: counts.indexer_registry_failed,
				providerSubscriptionActive:
					counts.provider_subscription_active,
				providerSubscriptionFailed:
					counts.provider_subscription_failed,
				reorgReplayActive: counts.reorg_replay_active,
				reorgReplayFailed: counts.reorg_replay_failed,
				indexerActiveShards: counts.indexer_active_shards,
			},
			streams: streamViews,
		},
		warnings: [...new Set(warnings)],
	};
}

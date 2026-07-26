import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";

const STREAM_WARNING_AGE_MS = 5 * 60_000;

type CountRow = {
	payment_reconcile_dead: number;
	payment_reconcile_active: number;
	user_event_dead: number;
	user_event_active: number;
	balance_refresh_failed: number;
	balance_projection_drift: number;
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
		balanceRefreshFailed: number;
		balanceProjectionDrift: number;
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
	const expectedStreams = [
		`erc20_transfers:${network.chainId}`,
		`userops:${network.chainId}`,
		`router:${network.chainId}`,
		`recovery:${network.chainId}`,
	];
	const placeholders = expectedStreams.map(() => "?").join(", ");
	const [counts, streams, walletCount] = await Promise.all([
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
				 WHERE status = 'failed') AS balance_refresh_failed,
				(SELECT COUNT(*) FROM balance_reconciliation_audits
				 WHERE outcome = 'drift') AS balance_projection_drift`,
		).first<CountRow>(),
		env.PARMELIA_DB.prepare(
			`SELECT stream, block_number, updated_at
			 FROM chain_stream_checkpoints
			 WHERE chain_id = ? AND stream IN (${placeholders})`,
		)
			.bind(network.chainId, ...expectedStreams)
			.all<StreamRow>(),
		env.PARMELIA_DB.prepare(
			`SELECT COUNT(*) AS count
			 FROM users
			 WHERE wallet_address IS NOT NULL`,
		).first<{ count: number }>(),
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
	// A brand-new deployment has no checkpoint until its first successful cron
	// pass. Do not report every stream as missing during that bootstrap window.
	// Once at least one canonical stream has started, missing/stale siblings are
	// actionable and should degrade readiness.
	if ((walletCount?.count ?? 0) > 0 && streamViews.length > 0) {
		const byName = new Map(streamViews.map((stream) => [stream.name, stream]));
		for (const expected of expectedStreams) {
			const stream = byName.get(expected);
			if (!stream) {
				warnings.push(`canonical_stream_missing:${expected.split(":")[0]}`);
			} else if (
				stream.ageSeconds === null ||
				stream.ageSeconds * 1_000 > STREAM_WARNING_AGE_MS
			) {
				warnings.push(`canonical_stream_stale:${expected.split(":")[0]}`);
			}
		}
	}

	return {
		summary: {
			queues: {
				paymentReconcileActive: counts.payment_reconcile_active,
				paymentReconcileDead: counts.payment_reconcile_dead,
				userEventActive: counts.user_event_active,
				userEventDead: counts.user_event_dead,
				balanceRefreshFailed: counts.balance_refresh_failed,
				balanceProjectionDrift: counts.balance_projection_drift,
			},
			streams: streamViews,
		},
		warnings: [...new Set(warnings)],
	};
}

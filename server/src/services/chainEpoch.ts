import type { Bindings } from "../middlewares/auth";

export type ChainEpochGuard = {
	id: string;
	chainId: number;
	expectedEpoch: number;
	createdAt: string;
};

export async function getChainReorgEpoch(
	env: Bindings,
	chainId: number,
): Promise<number> {
	const row = await env.GATOPAGO_DB.prepare(
		`SELECT epoch FROM chain_reorg_state WHERE chain_id = ?`,
	)
		.bind(chainId)
		.first<{ epoch: number }>();
	return row?.epoch ?? 0;
}

export function createChainEpochGuard(
	chainId: number,
	expectedEpoch: number,
): ChainEpochGuard {
	if (
		!Number.isSafeInteger(chainId) ||
		chainId < 1 ||
		!Number.isSafeInteger(expectedEpoch) ||
		expectedEpoch < 0
	) {
		throw new Error("Chain epoch guard is invalid");
	}
	return {
		id: crypto.randomUUID(),
		chainId,
		expectedEpoch,
		createdAt: new Date().toISOString(),
	};
}

export function prepareChainEpochGuardInsert(
	env: Bindings,
	guard: ChainEpochGuard,
): D1PreparedStatement {
	return env.GATOPAGO_DB.prepare(
		`INSERT INTO chain_reorg_epoch_guards (
			id, chain_id, expected_epoch, created_at
		 ) VALUES (?, ?, ?, ?)`,
	).bind(
		guard.id,
		guard.chainId,
		guard.expectedEpoch,
		guard.createdAt,
	);
}

export function prepareChainEpochGuardDelete(
	env: Bindings,
	guard: ChainEpochGuard,
): D1PreparedStatement {
	return env.GATOPAGO_DB.prepare(
		`DELETE FROM chain_reorg_epoch_guards WHERE id = ?`,
	).bind(guard.id);
}

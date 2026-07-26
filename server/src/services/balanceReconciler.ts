import {
	type Address,
	type ContractFunctionParameters,
} from "viem";
import { erc20Abi, getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import {
	claimBalanceRefresh,
	completeBalanceRefresh,
	failBalanceRefresh,
	listDueBalanceRefreshes,
	parseBalanceRefreshMessage,
	requestBalanceRefresh,
	type BalanceProjectionStrategy,
	type BalanceRefreshMessage,
	type BalanceRefreshRequest,
	type BalanceSnapshot,
	upsertBalanceSnapshots,
} from "./balanceReadModel";
import { getIndexerScanHead } from "./chainHead";
import { getPublicClient } from "./clients";
import { logError, logInfo, logWarn } from "./logger";
import { getArbitrumBlockEvidence } from "./arbitrumFinality";
import { auditBalanceProjectionDrift } from "./balanceDrift";

const MULTICALL3_BALANCE_ABI = [
	{
		type: "function",
		name: "getEthBalance",
		stateMutability: "view",
		inputs: [{ name: "addr", type: "address" }],
		outputs: [{ name: "balance", type: "uint256" }],
	},
] as const;

const PROJECTION_VERSION = 1;
const CLAIM_LEASE_MS = 90_000;

type ClaimedRefresh = {
	request: BalanceRefreshMessage;
	owner: string;
};

type CallDescriptor = {
	requestKey: string;
	uid: string;
	accountAddress: Address;
	asset: string;
	decimals: number;
	strategy: BalanceProjectionStrategy;
};

function asBoundedBatchSize(raw: string | undefined): number {
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) return 25;
	return Math.min(100, Math.max(1, parsed));
}

async function reconcileClaimed(
	env: Bindings,
	claimed: ClaimedRefresh[],
): Promise<Set<string>> {
	if (claimed.length === 0) return new Set();
	const network = getNetworkConfig(env.CHAIN_KEY);
	const policyRows = await env.PARMELIA_DB.prepare(
		`SELECT asset, strategy, enabled
		 FROM asset_indexing_policies
		 WHERE chain_id = ?`,
	)
		.bind(network.chainId)
		.all<{
			asset: string;
			strategy: BalanceProjectionStrategy;
			enabled: number;
		}>();
	const strategyByAsset = new Map(
		policyRows.results.map((row) => [
			row.asset,
			row.enabled === 1 ? row.strategy : ("rpc_only" as const),
		]),
	);
	const strategyFor = (asset: string): BalanceProjectionStrategy =>
		strategyByAsset.get(asset) ?? "rpc_only";
	const supported = claimed.filter(
		(item) => item.request.chainId === network.chainId,
	);
	if (supported.length !== claimed.length) {
		throw new Error("Balance refresh message targets the wrong active chain");
	}

	const publicClient = getPublicClient(env);
	const { scanHead, finalitySource } = await getIndexerScanHead(publicClient);
	for (const { request } of supported) {
		if (
			request.notBeforeBlock !== undefined &&
			scanHead < BigInt(request.notBeforeBlock)
		) {
			throw new Error("Canonical head has not reached notBeforeBlock");
		}
	}

	const targetBlock = await publicClient.getBlock({
		blockNumber: scanHead,
		includeTransactions: false,
	});
	if (!targetBlock.hash) throw new Error("RPC returned a target block without hash");
	const finalityEvidence = await getArbitrumBlockEvidence(env, publicClient, {
		blockNumber: scanHead,
		blockHash: targetBlock.hash,
	});

	const multicallAddress = publicClient.chain.contracts?.multicall3?.address;
	const calls: ContractFunctionParameters[] = [];
	const descriptors: CallDescriptor[] = [];

	for (const { request } of supported) {
		if (multicallAddress) {
			calls.push({
				address: multicallAddress,
				abi: MULTICALL3_BALANCE_ABI,
				functionName: "getEthBalance",
				args: [request.accountAddress],
			});
			descriptors.push({
				requestKey: request.idempotencyKey,
				uid: request.uid,
				accountAddress: request.accountAddress,
				asset: network.nativeTokenSymbol,
				decimals: 18,
				strategy: strategyFor(network.nativeTokenSymbol),
			});
		}

		for (const token of network.tokens) {
			if (!token.address) continue;
			calls.push({
				address: token.address,
				abi: erc20Abi,
				functionName: "balanceOf",
				args: [request.accountAddress],
			});
			descriptors.push({
				requestKey: request.idempotencyKey,
				uid: request.uid,
				accountAddress: request.accountAddress,
				asset: token.symbol,
				decimals: token.decimals,
				strategy: strategyFor(token.symbol),
			});
		}

		if (network.aave) {
			calls.push({
				address: network.aave.aUsdc,
				abi: erc20Abi,
				functionName: "balanceOf",
				args: [request.accountAddress],
			});
			descriptors.push({
				requestKey: request.idempotencyKey,
				uid: request.uid,
				accountAddress: request.accountAddress,
				asset: "aUSDC",
				decimals: network.contracts.usdcDecimals,
				strategy: strategyFor("aUSDC"),
			});
		}
	}

	const results =
		calls.length === 0
			? []
			: await publicClient.multicall({
					contracts: calls,
					allowFailure: true,
					blockNumber: scanHead,
				});

	// Chains without a configured Multicall3 fall back to one native balance
	// call per wallet. Arbitrum One/Sepolia both configure Multicall3 in viem.
	const nativeFallback = new Map<string, bigint>();
	if (!multicallAddress) {
		await Promise.all(
			supported.map(async ({ request }) => {
				const value = await publicClient.getBalance({
					address: request.accountAddress,
					blockNumber: scanHead,
				});
				nativeFallback.set(request.idempotencyKey, value);
			}),
		);
	}

	const now = new Date().toISOString();
	const consistencyLevel =
		finalityEvidence.source === "node_interface"
			? finalityEvidence.consistencyLevel
			: finalitySource === "safe"
				? ("safe" as const)
				: ("sequenced" as const);
	const snapshots: BalanceSnapshot[] = [];
	const failedRequestKeys = new Set<string>();

	for (let index = 0; index < descriptors.length; index++) {
		const descriptor = descriptors[index];
		const result = results[index];
		if (!result || result.status !== "success" || typeof result.result !== "bigint") {
			failedRequestKeys.add(descriptor.requestKey);
			continue;
		}
		snapshots.push({
			uid: descriptor.uid,
			accountAddress: descriptor.accountAddress,
			chainId: network.chainId,
			asset: descriptor.asset,
			balanceRaw: result.result,
			decimals: descriptor.decimals,
			blockNumber: scanHead,
			blockHash: targetBlock.hash,
			consistencyLevel,
			projectionStrategy: descriptor.strategy,
			projectionVersion: PROJECTION_VERSION,
			observedAt: now,
			reconciledAt: now,
			source: "rpc_reconcile",
		});
	}

	if (!multicallAddress) {
		for (const { request } of supported) {
			const balance = nativeFallback.get(request.idempotencyKey);
			if (balance === undefined) {
				failedRequestKeys.add(request.idempotencyKey);
				continue;
			}
			snapshots.push({
				uid: request.uid,
				accountAddress: request.accountAddress,
				chainId: network.chainId,
				asset: network.nativeTokenSymbol,
				balanceRaw: balance,
				decimals: 18,
				blockNumber: scanHead,
				blockHash: targetBlock.hash,
				consistencyLevel,
				projectionStrategy: strategyFor(network.nativeTokenSymbol),
				projectionVersion: PROJECTION_VERSION,
				observedAt: now,
				reconciledAt: now,
				source: "rpc_reconcile",
			});
		}
	}

	// Verify the exact block still belongs to the provider's canonical view
	// before committing a coherent multi-asset snapshot.
	const verifiedBlock = await publicClient.getBlock({
		blockNumber: scanHead,
		includeTransactions: false,
	});
	if (
		!verifiedBlock.hash ||
		verifiedBlock.hash.toLowerCase() !== targetBlock.hash.toLowerCase()
	) {
		throw new Error("Target block changed during balance reconciliation");
	}

	// Never publish a partial wallet as a successful refresh.
	const validSnapshots = snapshots.filter(
		(snapshot) =>
			!failedRequestKeys.has(
				`${snapshot.chainId}:${snapshot.accountAddress.toLowerCase()}`,
			),
	);
	await upsertBalanceSnapshots(env, validSnapshots);
	await auditBalanceProjectionDrift(env, validSnapshots).catch((error) => {
		// Snapshot freshness must not be held hostage by a shadow-audit failure.
		logError("balance_projection_audit_failed", error, {
			chainId: network.chainId,
			snapshots: validSnapshots.length,
		});
	});
	const completed = new Set(
		supported
			.map(({ request }) => request.idempotencyKey)
			.filter((key) => !failedRequestKeys.has(key)),
	);

	logInfo("balance_reconcile_batch", {
		chainId: network.chainId,
		wallets: supported.length,
		assetsWritten: validSnapshots.length,
		failedWallets: failedRequestKeys.size,
		blockNumber: scanHead.toString(),
		consistencyLevel,
		rpcRequests:
			(multicallAddress ? 4 : 3 + supported.length) +
			finalityEvidence.rpcCalls,
		rpcSubcalls: calls.length,
		l1Confirmations:
			finalityEvidence.l1Confirmations?.toString() ?? null,
	});
	return completed;
}

async function processClaimedBatch(
	env: Bindings,
	claimed: ClaimedRefresh[],
): Promise<Set<string>> {
	try {
		const completedKeys = await reconcileClaimed(env, claimed);
		for (const item of claimed) {
			if (completedKeys.has(item.request.idempotencyKey)) {
				await completeBalanceRefresh(env, item.request, item.owner);
			} else {
				await failBalanceRefresh(
					env,
					item.request,
					item.owner,
					"RPC_PARTIAL_RESULT",
				);
			}
		}
		return completedKeys;
	} catch (error) {
		await Promise.all(
			claimed.map((item) =>
				failBalanceRefresh(
					env,
					item.request,
					item.owner,
					error instanceof Error && error.message.includes("notBeforeBlock")
						? "HEAD_NOT_READY"
						: "RPC_RECONCILE_FAILED",
				),
			),
		);
		throw error;
	}
}

async function claimMessages(
	env: Bindings,
	messages: BalanceRefreshMessage[],
): Promise<ClaimedRefresh[]> {
	const deduped = new Map(messages.map((message) => [message.idempotencyKey, message]));
	const claimed: ClaimedRefresh[] = [];
	for (const request of deduped.values()) {
		const owner = await claimBalanceRefresh(env, request, CLAIM_LEASE_MS);
		if (owner) claimed.push({ request, owner });
	}
	return claimed;
}

/** Cloudflare Queue consumer. Individual messages are acked/retried safely. */
export async function consumeBalanceRefreshQueue(
	batch: MessageBatch<unknown>,
	env: Bindings,
): Promise<void> {
	const validByKey = new Map<
		string,
		{ message: Message<unknown>; body: BalanceRefreshMessage }
	>();
	for (const message of batch.messages) {
		const parsed = parseBalanceRefreshMessage(message.body);
		if (!parsed) {
			logWarn("balance_refresh_message_rejected", {
				messageId: message.id,
				reason: "invalid_schema",
			});
			message.ack();
			continue;
		}
		const existing = validByKey.get(parsed.idempotencyKey);
		if (existing) {
			// One work item satisfies every duplicate delivery in this batch.
			message.ack();
			continue;
		}
		validByKey.set(parsed.idempotencyKey, { message, body: parsed });
	}

	const claimed = await claimMessages(
		env,
		[...validByKey.values()].map((entry) => entry.body),
	);
	const claimedKeys = new Set(
		claimed.map((item) => item.request.idempotencyKey),
	);
	if (claimed.length === 0) {
		for (const entry of validByKey.values()) entry.message.ack();
		return;
	}

	try {
		const completed = await processClaimedBatch(env, claimed);
		for (const [key, entry] of validByKey) {
			if (!claimedKeys.has(key) || completed.has(key)) entry.message.ack();
			else entry.message.retry({ delaySeconds: 10 });
		}
	} catch (error) {
		logError("balance_refresh_queue_batch_failed", error, {
			messages: claimed.length,
		});
		for (const [key, entry] of validByKey) {
			if (!claimedKeys.has(key)) entry.message.ack();
			else entry.message.retry({ delaySeconds: 10 });
		}
	}
}

/** D1-backed repair path used by cron when Queue is absent or delivery failed. */
export async function drainBalanceRefreshRequests(env: Bindings): Promise<void> {
	const due = await listDueBalanceRefreshes(
		env,
		asBoundedBatchSize(undefined),
	);
	if (due.length === 0) return;
	const messages = due.map<BalanceRefreshMessage>((request: BalanceRefreshRequest) => ({
		schemaVersion: 1,
		idempotencyKey: request.idempotencyKey,
		uid: request.uid,
		accountAddress: request.accountAddress,
		chainId: request.chainId,
		reason: request.reason,
		priority: request.priority,
		notBeforeBlock: request.notBeforeBlock,
	}));
	const claimed = await claimMessages(env, messages);
	if (claimed.length === 0) return;
	await processClaimedBatch(env, claimed).catch((error) => {
		logError("balance_refresh_cron_batch_failed", error, {
			requests: claimed.length,
		});
	});
}

/**
 * Bounded global maintenance for assets that cannot be exact from logs (native
 * ETH and, until promoted, rebasing aUSDC). This budget is independent of Home
 * traffic: 1 or 1,000 open tabs schedule exactly zero stale-snapshot RPC calls.
 */
export async function scheduleStaleRpcOnlyBalanceMaintenance(
	env: Bindings,
): Promise<number> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const configuredRefreshSeconds = Number(
		env.BALANCE_RPC_ONLY_REFRESH_SECONDS,
	);
	const refreshSeconds =
		Number.isSafeInteger(configuredRefreshSeconds) &&
		configuredRefreshSeconds >= 60 &&
		configuredRefreshSeconds <= 86_400
			? configuredRefreshSeconds
			: 900;
	const batchSize = asBoundedBatchSize(
		env.BALANCE_MAINTENANCE_BATCH_SIZE,
	);
	const cutoff = new Date(
		Date.now() - refreshSeconds * 1_000,
	).toISOString();
	const result = await env.PARMELIA_DB.prepare(
		`SELECT u.uid, u.wallet_address AS account_address,
		        COALESCE((
		        	SELECT MIN(bs_oldest.observed_at)
		        	FROM balance_snapshots bs_oldest
		        	JOIN asset_indexing_policies aip_oldest
		        	  ON aip_oldest.chain_id = bs_oldest.chain_id
		        	 AND aip_oldest.asset = bs_oldest.asset
		        	 AND aip_oldest.enabled = 1
		        	 AND aip_oldest.strategy = 'rpc_only'
		        	WHERE bs_oldest.uid = u.uid
		        	  AND bs_oldest.chain_id = ?
		        	  AND bs_oldest.canonical = 1
		        ), '1970-01-01T00:00:00.000Z') AS oldest
		 FROM users u
		 WHERE u.wallet_address IS NOT NULL
		   AND u.wallet_address <> ''
		   AND EXISTS (
		   	SELECT 1
		   	FROM asset_indexing_policies aip
		   	LEFT JOIN balance_snapshots bs
		   	  ON bs.uid = u.uid
		   	 AND bs.chain_id = aip.chain_id
		   	 AND bs.asset = aip.asset
		   	 AND bs.canonical = 1
		   	WHERE aip.chain_id = ?
		   	  AND aip.enabled = 1
		   	  AND aip.strategy = 'rpc_only'
		   	  AND (bs.uid IS NULL OR bs.observed_at <= ?)
		   )
		   AND NOT EXISTS (
		   	SELECT 1
		   	FROM balance_refresh_requests brr
		   	WHERE brr.chain_id = ?
		   	  AND brr.account_address = LOWER(u.wallet_address)
		   	  AND brr.status IN ('pending', 'processing')
		   )
		 ORDER BY oldest ASC, u.uid ASC
		 LIMIT ?`,
	)
		.bind(
			network.chainId,
			network.chainId,
			cutoff,
			network.chainId,
			batchSize,
		)
		.all<{
			uid: string;
			account_address: Address;
			oldest: string;
		}>();
	for (const row of result.results) {
		await requestBalanceRefresh(env, {
			uid: row.uid,
			accountAddress: row.account_address,
			chainId: network.chainId,
			reason: "scheduled_rpc_only_asset_audit",
			priority: 4,
		});
	}
	if (result.results.length > 0) {
		logInfo("balance_rpc_only_maintenance_scheduled", {
			chainId: network.chainId,
			wallets: result.results.length,
			refreshSeconds,
			includesMissingBootstrap: true,
		});
	}
	return result.results.length;
}

export const __test = {
	reconcileClaimed,
};

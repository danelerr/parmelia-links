import {
	type Address,
	type ContractFunctionParameters,
} from "viem";
import { erc20Abi, getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import {
	claimBalanceRefreshBatch,
	finishBalanceRefreshBatch,
	listDueBalanceRefreshes,
	type BalanceProjectionStrategy,
	type BalanceRefreshMessage,
	type BalanceRefreshRequest,
	type BalanceSnapshot,
	type ClaimedBalanceRefresh,
	upsertBalanceSnapshots,
} from "./balanceReadModel";
import { getIndexerScanHead } from "./chainHead";
import { getPublicClient } from "./clients";
import { logError, logInfo } from "./logger";
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

type CallDescriptor = {
	requestKey: string;
	uid: string;
	accountAddress: Address;
	asset: string;
	decimals: number;
	strategy: BalanceProjectionStrategy;
};

export type InteractiveBalanceRefreshInput = {
	uid: string;
	accountAddress: Address;
	chainId: number;
};

function asBoundedBatchSize(raw: string | undefined): number {
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed)) return 25;
	return Math.min(100, Math.max(1, parsed));
}

/**
 * User-triggered freshness path for transactional screens (Earn/Swap/Crosschain).
 *
 * The canonical reconciler intentionally reads a safe head. That is correct for
 * accounting, but it made a just-mined operation look frozen for up to minutes.
 * This path reads one coherent latest-block Multicall and publishes it as
 * `sequenced`; the safe reconciler later supersedes it as the safe head catches
 * up. Home never calls this function, so idle users still generate zero RPC work.
 */
export async function refreshWalletBalancesLatest(
	env: Bindings,
	input: InteractiveBalanceRefreshInput,
): Promise<BalanceSnapshot[]> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	if (input.chainId !== network.chainId) {
		throw new Error("Interactive balance refresh targets the wrong active chain");
	}

	const publicClient = getPublicClient(env);
	const targetBlock = await publicClient.getBlock({
		blockTag: "latest",
		includeTransactions: false,
	});
	if (targetBlock.number === null || !targetBlock.hash) {
		throw new Error("RPC returned a latest block without canonical coordinates");
	}

	const multicallAddress = publicClient.chain.contracts?.multicall3?.address;
	const calls: ContractFunctionParameters[] = [];
	const descriptors: Array<{
		asset: string;
		decimals: number;
	}> = [];

	if (multicallAddress) {
		calls.push({
			address: multicallAddress,
			abi: MULTICALL3_BALANCE_ABI,
			functionName: "getEthBalance",
			args: [input.accountAddress],
		});
		descriptors.push({
			asset: network.nativeTokenSymbol,
			decimals: 18,
		});
	}

	for (const token of network.tokens) {
		if (!token.address) continue;
		calls.push({
			address: token.address,
			abi: erc20Abi,
			functionName: "balanceOf",
			args: [input.accountAddress],
		});
		descriptors.push({
			asset: token.symbol,
			decimals: token.decimals,
		});
	}

	if (network.aave) {
		calls.push({
			address: network.aave.aUsdc,
			abi: erc20Abi,
			functionName: "balanceOf",
			args: [input.accountAddress],
		});
		descriptors.push({
			asset: "aUSDC",
			decimals: network.contracts.usdcDecimals,
		});
	}

	const results =
		calls.length === 0
			? []
			: await publicClient.multicall({
					contracts: calls,
					allowFailure: true,
					blockNumber: targetBlock.number,
				});
	const now = new Date().toISOString();
	const snapshots: BalanceSnapshot[] = [];

	for (let index = 0; index < descriptors.length; index++) {
		const descriptor = descriptors[index];
		const result = results[index];
		if (
			!result ||
			result.status !== "success" ||
			typeof result.result !== "bigint"
		) {
			throw new Error(`Interactive balance read failed for ${descriptor.asset}`);
		}
		snapshots.push({
			uid: input.uid,
			accountAddress: input.accountAddress,
			chainId: network.chainId,
			asset: descriptor.asset,
			balanceRaw: result.result,
			decimals: descriptor.decimals,
			blockNumber: targetBlock.number,
			blockHash: targetBlock.hash,
			consistencyLevel: "sequenced",
			projectionStrategy: "rpc_only",
			projectionVersion: PROJECTION_VERSION,
			observedAt: now,
			reconciledAt: now,
			source: "rpc_interactive_latest",
		});
	}

	if (!multicallAddress) {
		const nativeBalance = await publicClient.getBalance({
			address: input.accountAddress,
			blockNumber: targetBlock.number,
		});
		snapshots.push({
			uid: input.uid,
			accountAddress: input.accountAddress,
			chainId: network.chainId,
			asset: network.nativeTokenSymbol,
			balanceRaw: nativeBalance,
			decimals: 18,
			blockNumber: targetBlock.number,
			blockHash: targetBlock.hash,
			consistencyLevel: "sequenced",
			projectionStrategy: "rpc_only",
			projectionVersion: PROJECTION_VERSION,
			observedAt: now,
			reconciledAt: now,
			source: "rpc_interactive_latest",
		});
	}

	// A latest block can be replaced by a sequencer reorg while the Multicall is
	// running. Verify the exact hash before exposing the snapshot.
	const verifiedBlock = await publicClient.getBlock({
		blockNumber: targetBlock.number,
		includeTransactions: false,
	});
	if (
		!verifiedBlock.hash ||
		verifiedBlock.hash.toLowerCase() !== targetBlock.hash.toLowerCase()
	) {
		throw new Error("Latest block changed during interactive balance refresh");
	}

	await upsertBalanceSnapshots(env, snapshots);
	return snapshots;
}

async function reconcileClaimed(
	env: Bindings,
	claimed: ClaimedBalanceRefresh[],
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
	claimed: ClaimedBalanceRefresh[],
): Promise<Set<string>> {
	let completedKeys: Set<string>;
	try {
		completedKeys = await reconcileClaimed(env, claimed);
	} catch (error) {
		const errorCode =
			error instanceof Error && error.message.includes("notBeforeBlock")
				? "HEAD_NOT_READY"
				: "RPC_RECONCILE_FAILED";
		await finishBalanceRefreshBatch(
			env,
			claimed.map((item) => ({
				...item,
				status: "failed",
				errorCode,
			})),
		);
		throw error;
	}
	await finishBalanceRefreshBatch(
		env,
		claimed.map((item) =>
			completedKeys.has(item.request.idempotencyKey)
				? { ...item, status: "completed" as const }
				: {
						...item,
						status: "failed" as const,
						errorCode: "RPC_PARTIAL_RESULT",
					},
		),
	);
	return completedKeys;
}

async function claimMessages(
	env: Bindings,
	messages: BalanceRefreshMessage[],
): Promise<ClaimedBalanceRefresh[]> {
	const deduped = new Map(messages.map((message) => [message.idempotencyKey, message]));
	return claimBalanceRefreshBatch(
		env,
		[...deduped.values()],
		CLAIM_LEASE_MS,
	);
}

/** D1-backed repair path used only when an event proves work is due. */
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
		logError("balance_refresh_batch_failed", error, {
			requests: claimed.length,
		});
	});
}

export const __test = {
	reconcileClaimed,
};

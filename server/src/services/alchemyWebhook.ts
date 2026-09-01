import type { Address } from "viem";
import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import {
	finishSourceDelivery,
	getSourceDelivery,
	recordSourceDelivery,
} from "./chainJournal";
import { requestBalanceRefreshBatch } from "./balanceReadModel";
import {
	scheduleTransferIndexerPartitions,
	type TransferDirection,
} from "./indexerPartitions";
import { logInfo } from "./logger";
import { getAlchemyAddressWebhookConfigs } from "./alchemyWebhookConfig";
import { listActiveChainAccountOwnersByWalletAddresses } from "./storage";

const MAX_WEBHOOK_ACTIVITIES = 500;

type AlchemyActivity = {
	blockNum?: string;
	fromAddress?: string;
	toAddress?: string;
	log?: {
		address?: string;
		blockNumber?: string;
		removed?: boolean;
	};
};

type AlchemyEnvelope = {
	webhookId?: string;
	id?: string;
	type?: string;
	event?: {
		network?: string;
		activity?: AlchemyActivity[];
	};
};

type TransferSignal = {
	walletAddress: string;
	token: Address;
	direction: TransferDirection;
	targetBlock: bigint;
};

type BalanceSignal = {
	walletAddress: string;
	targetBlock: bigint;
};

function hexToBytes(value: string): ArrayBuffer | null {
	if (!/^[0-9a-fA-F]{64}$/u.test(value)) return null;
	const buffer = new ArrayBuffer(32);
	const bytes = new Uint8Array(buffer);
	for (let index = 0; index < 32; index++) {
		bytes[index] = Number.parseInt(
			value.slice(index * 2, index * 2 + 2),
			16,
		);
	}
	return buffer;
}

export async function verifyAlchemySignature(
	rawBody: string,
	signature: string | undefined,
	signingKey: string | undefined,
): Promise<boolean> {
	if (!signature || !signingKey) return false;
	const signatureBytes = hexToBytes(signature);
	if (!signatureBytes) return false;
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(signingKey),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["verify"],
	);
	return crypto.subtle.verify(
		"HMAC",
		key,
		signatureBytes,
		new TextEncoder().encode(rawBody),
	);
}

function parseEnvelope(rawBody: string): AlchemyEnvelope | null {
	try {
		const parsed = JSON.parse(rawBody) as AlchemyEnvelope;
		if (
			!parsed ||
			typeof parsed !== "object" ||
			typeof parsed.webhookId !== "string" ||
			typeof parsed.id !== "string" ||
			parsed.type !== "ADDRESS_ACTIVITY" ||
			!parsed.event ||
			typeof parsed.event.network !== "string" ||
			!Array.isArray(parsed.event.activity) ||
			parsed.event.activity.length > MAX_WEBHOOK_ACTIVITIES
		) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function parseBlockNumber(value: string | undefined): bigint | null {
	if (!value || !/^0x[0-9a-fA-F]+$/u.test(value)) return null;
	try {
		const block = BigInt(value);
		return block >= 0n ? block : null;
	} catch {
		return null;
	}
}

function normalizeSignals(
	activities: readonly AlchemyActivity[],
	supportedTokens: ReadonlySet<string>,
): TransferSignal[] {
	const signals = new Map<string, TransferSignal>();
	for (const activity of activities) {
		const token = activity.log?.address?.toLowerCase();
		const targetBlock = parseBlockNumber(
			activity.log?.blockNumber ?? activity.blockNum,
		);
		if (
			!token ||
			!/^0x[0-9a-f]{40}$/u.test(token) ||
			!supportedTokens.has(token) ||
			targetBlock === null
		) {
			continue;
		}
		for (const [walletAddress, direction] of [
			[activity.fromAddress, "from"],
			[activity.toAddress, "to"],
		] as const) {
			const wallet = walletAddress?.toLowerCase();
			if (!wallet || !/^0x[0-9a-f]{40}$/u.test(wallet)) continue;
			const key = `${token}:${direction}:${wallet}`;
			const prior = signals.get(key);
			if (!prior || targetBlock > prior.targetBlock) {
				signals.set(key, {
					walletAddress: wallet,
					token: token as Address,
					direction,
					targetBlock,
				});
			}
		}
	}
	return [...signals.values()];
}

function normalizeBalanceSignals(
	activities: readonly AlchemyActivity[],
): BalanceSignal[] {
	const signals = new Map<string, BalanceSignal>();
	for (const activity of activities) {
		const targetBlock = parseBlockNumber(
			activity.blockNum ?? activity.log?.blockNumber,
		);
		if (targetBlock === null) continue;
		for (const walletAddress of [
			activity.fromAddress,
			activity.toAddress,
		]) {
			const wallet = walletAddress?.toLowerCase();
			if (!wallet || !/^0x[0-9a-f]{40}$/u.test(wallet)) continue;
			const prior = signals.get(wallet);
			if (!prior || targetBlock > prior.targetBlock) {
				signals.set(wallet, {
					walletAddress: wallet,
					targetBlock,
				});
			}
		}
	}
	return [...signals.values()];
}

export type AlchemyWebhookProcessResult =
	| { status: "disabled" }
	| { status: "invalid_signature" }
	| { status: "invalid_payload" }
	| { status: "rejected_scope" }
	| { status: "duplicate"; deliveryId: string; events: number }
	| { status: "processed"; deliveryId: string; events: number };

/**
 * Address Activity is a provider signal, never financial truth. The request is
 * authenticated, deduplicated and mapped to exact indexer partitions; canonical
 * logs are then read through the configured RPC provider pool.
 */
export async function processAlchemyWebhook(
	env: Bindings,
	rawBody: string,
	signature: string | undefined,
): Promise<AlchemyWebhookProcessResult> {
	if (env.ALCHEMY_WEBHOOK_ENABLED !== "true") return { status: "disabled" };
	const envelope = parseEnvelope(rawBody);
	if (!envelope) return { status: "invalid_payload" };
	const webhook = getAlchemyAddressWebhookConfigs(env).find(
		(config) => config.id === envelope.webhookId,
	);
	if (!webhook) return { status: "rejected_scope" };
	if (
		!(await verifyAlchemySignature(
			rawBody,
			signature,
			webhook.signingKey,
		))
	) {
		return { status: "invalid_signature" };
	}
	if (envelope.event!.network !== webhook.network) {
		await recordSourceDelivery(env, {
			provider: "alchemy",
			deliveryId: envelope.id!,
			webhookId: envelope.webhookId,
			status: "rejected",
			errorCode: "SCOPE_MISMATCH",
		});
		return { status: "rejected_scope" };
	}
	const firstDelivery = await recordSourceDelivery(env, {
		provider: "alchemy",
		deliveryId: envelope.id!,
		webhookId: envelope.webhookId,
		status: "received",
	});
	if (!firstDelivery) {
		const prior = await getSourceDelivery(env, "alchemy", envelope.id!);
		if (prior?.status === "processed" || prior?.status === "rejected") {
			return {
				status: "duplicate",
				deliveryId: envelope.id!,
				events: prior.eventCount,
			};
		}
	}

	const network = getNetworkConfig(env.CHAIN_KEY);
	const supportedTokens = new Set(
		network.tokens
			.filter((token) => token.address)
			.map((token) => token.address!.toLowerCase()),
	);
	const signals = normalizeSignals(
		envelope.event!.activity!,
		supportedTokens,
	);
	const balanceSignals = normalizeBalanceSignals(
		envelope.event!.activity!,
	);
	const partitions = await scheduleTransferIndexerPartitions(
		env,
		signals,
		"alchemy_address_activity",
	);
	const balanceByWallet = new Map(
		balanceSignals.map((signal) => [signal.walletAddress, signal]),
	);
	const users = await listActiveChainAccountOwnersByWalletAddresses(
		env,
		network.chainId,
		balanceSignals.map((signal) => signal.walletAddress),
	);
	await requestBalanceRefreshBatch(
		env,
		users.flatMap((user) => {
			const signal = balanceByWallet.get(
				user.walletAddress.toLowerCase(),
			);
			return signal
				? [{
						uid: user.uid,
						accountAddress: user.walletAddress as Address,
						chainId: network.chainId,
						reason: "alchemy_address_activity",
						priority: 1 as const,
						notBeforeBlock: signal.targetBlock.toString(),
					}]
				: [];
		}),
	);
	await finishSourceDelivery(
		env,
		"alchemy",
		envelope.id!,
		"processed",
		signals.length,
	);
	logInfo("alchemy_webhook_signal_processed", {
		deliveryId: envelope.id!,
		activities: envelope.event!.activity!.length,
		signals: signals.length,
		balanceSignals: users.length,
		partitions,
	});
	return {
		status: "processed",
		deliveryId: envelope.id!,
		events: signals.length,
	};
}

export const __test = {
	parseEnvelope,
	normalizeSignals,
	normalizeBalanceSignals,
};

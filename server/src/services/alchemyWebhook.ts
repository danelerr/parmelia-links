import {
	decodeEventLog,
	parseAbiItem,
	type Address,
	type Hex,
} from "viem";
import { formatUnits } from "viem";
import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import {
	chainEventId,
	finishSourceDelivery,
	getSourceDelivery,
	journalBlockEvents,
	recordSourceDelivery,
	type JournalEvent,
} from "./chainJournal";
import {
	balanceProjectionAccountKey,
	markProjectionOccurrenceNoncanonical,
	projectBalanceDeltas,
} from "./balanceProjector";
import {
	getFaucetAccount,
	getIndexerClient,
	getRpcUrls,
	getServerAccount,
} from "./clients";
import {
	listUsersByWalletAddresses,
	writeLedgerEntries,
	type LedgerEntry,
} from "./storage";
import { requestBalanceRefresh } from "./balanceReadModel";
import { logInfo } from "./logger";
import { getArbitrumBlockEvidence } from "./arbitrumFinality";

const TRANSFER_EVENT = parseAbiItem(
	"event Transfer(address indexed from, address indexed to, uint256 value)",
);
const TRANSFER_TOPIC =
	"0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const MAX_WEBHOOK_ACTIVITIES = 500;

type AlchemyActivity = {
	fromAddress?: string;
	toAddress?: string;
	category?: string;
	rawContract?: {
		address?: string | null;
		rawValue?: string | null;
		decimals?: number | null;
	};
	log?: {
		address?: string;
		topics?: string[];
		data?: string;
		blockNumber?: string;
		transactionHash?: string;
		transactionIndex?: string;
		blockHash?: string;
		logIndex?: string;
		removed?: boolean;
	};
};

type AlchemyEnvelope = {
	webhookId?: string;
	id?: string;
	createdAt?: string;
	type?: string;
	event?: {
		network?: string;
		activity?: AlchemyActivity[];
	};
};

type NormalizedActivity = {
	txHash: Hex;
	logIndex: number;
	blockNumber: bigint;
	blockHash: Hex;
	transactionIndex: number | null;
	contractAddress: Address;
	topic0: Hex;
	from: Address;
	to: Address;
	value: bigint;
	removed: boolean;
};

function hexToBytes(value: string): ArrayBuffer | null {
	if (!/^[0-9a-fA-F]{64}$/.test(value)) return null;
	const buffer = new ArrayBuffer(32);
	const bytes = new Uint8Array(buffer);
	for (let index = 0; index < 32; index++) {
		bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
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

function parseHexInteger(
	value: string | undefined,
	max: bigint = BigInt(Number.MAX_SAFE_INTEGER),
): bigint | null {
	if (!value || !/^0x[0-9a-fA-F]+$/.test(value)) return null;
	const parsed = BigInt(value);
	return parsed <= max ? parsed : null;
}

function normalizeActivity(activity: AlchemyActivity): NormalizedActivity | null {
	const log = activity.log;
	if (
		!log ||
		!Array.isArray(log.topics) ||
		log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC ||
		!/^0x[0-9a-fA-F]{40}$/.test(log.address ?? "") ||
		!/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash ?? "") ||
		!/^0x[0-9a-fA-F]{64}$/.test(log.blockHash ?? "") ||
		!/^0x[0-9a-fA-F]*$/.test(log.data ?? "")
	) {
		return null;
	}
	const blockNumber = parseHexInteger(log.blockNumber);
	const logIndex = parseHexInteger(log.logIndex);
	const transactionIndex = parseHexInteger(log.transactionIndex);
	if (
		blockNumber === null ||
		logIndex === null ||
		logIndex > BigInt(Number.MAX_SAFE_INTEGER)
	) {
		return null;
	}
	try {
		const decoded = decodeEventLog({
			abi: [TRANSFER_EVENT],
			data: log.data as Hex,
			topics: log.topics as [Hex, ...Hex[]],
			strict: true,
		});
		const args = decoded.args as {
			from: Address;
			to: Address;
			value: bigint;
		};
		if (
			activity.fromAddress &&
			args.from.toLowerCase() !== activity.fromAddress.toLowerCase()
		) return null;
		if (
			activity.toAddress &&
			args.to.toLowerCase() !== activity.toAddress.toLowerCase()
		) return null;
		return {
			txHash: log.transactionHash as Hex,
			logIndex: Number(logIndex),
			blockNumber,
			blockHash: log.blockHash as Hex,
			transactionIndex:
				transactionIndex === null ? null : Number(transactionIndex),
			contractAddress: log.address as Address,
			topic0: log.topics[0] as Hex,
			from: args.from,
			to: args.to,
			value: args.value,
			removed: log.removed === true,
		};
	} catch {
		return null;
	}
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

async function affectedAccountsForOccurrence(
	env: Bindings,
	eventId: string,
	blockHash: Hex,
): Promise<Array<{ uid: string; accountAddress: Address }>> {
	const result = await env.PARMELIA_DB.prepare(
		`SELECT DISTINCT uid, account_address
		 FROM chain_event_accounts
		 WHERE event_id = ? AND block_hash = ?`,
	)
		.bind(eventId, blockHash.toLowerCase())
		.all<{ uid: string; account_address: string }>();
	return result.results.map((row) => ({
		uid: row.uid,
		accountAddress: row.account_address as Address,
	}));
}

async function handleRemovedActivity(
	env: Bindings,
	activity: NormalizedActivity,
): Promise<void> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const eventId = chainEventId(
		network.chainId,
		activity.txHash,
		activity.logIndex,
		"erc20.Transfer",
	);
	const affected = await affectedAccountsForOccurrence(
		env,
		eventId,
		activity.blockHash,
	);
	await markProjectionOccurrenceNoncanonical(env, eventId, activity.blockHash);
	await env.PARMELIA_DB.batch([
		env.PARMELIA_DB.prepare(
			`UPDATE chain_blocks SET canonical = 0
			 WHERE chain_id = ? AND block_hash = ?`,
		).bind(network.chainId, activity.blockHash.toLowerCase()),
		env.PARMELIA_DB.prepare(
			`UPDATE ledger SET canonical = 0
			 WHERE chain_id = ? AND tx_hash = ? AND log_index = ?
			   AND block_hash = ? AND canonical = 1`,
		).bind(
			network.chainId,
			activity.txHash.toLowerCase(),
			activity.logIndex,
			activity.blockHash.toLowerCase(),
		),
		env.PARMELIA_DB.prepare(
			`UPDATE balance_snapshots SET canonical = 0
			 WHERE chain_id = ? AND block_hash = ? AND canonical = 1`,
		).bind(network.chainId, activity.blockHash.toLowerCase()),
		env.PARMELIA_DB.prepare(
			`DELETE FROM chain_stream_checkpoints
			 WHERE chain_id = ? AND stream = ? AND block_hash = ?`,
		).bind(
			network.chainId,
			`alchemy_address_activity:${network.chainId}`,
			activity.blockHash.toLowerCase(),
		),
	]);
	for (const account of affected) {
		await requestBalanceRefresh(env, {
			uid: account.uid,
			accountAddress: account.accountAddress,
			chainId: network.chainId,
			reason: "alchemy_removed_log",
			priority: 0,
		});
	}
}

export type AlchemyWebhookProcessResult =
	| { status: "disabled" }
	| { status: "invalid_signature" }
	| { status: "invalid_payload" }
	| { status: "rejected_scope" }
	| { status: "duplicate"; deliveryId: string; events: number }
	| { status: "processed"; deliveryId: string; events: number };

export async function processAlchemyWebhook(
	env: Bindings,
	rawBody: string,
	signature: string | undefined,
): Promise<AlchemyWebhookProcessResult> {
	if (env.ALCHEMY_WEBHOOK_ENABLED !== "true") return { status: "disabled" };
	if (
		!(await verifyAlchemySignature(
			rawBody,
			signature,
			env.ALCHEMY_WEBHOOK_SIGNING_KEY,
		))
	) {
		return { status: "invalid_signature" };
	}
	const envelope = parseEnvelope(rawBody);
	if (!envelope) return { status: "invalid_payload" };
	if (
		envelope.webhookId !== env.ALCHEMY_WEBHOOK_ID ||
		envelope.event!.network !== env.ALCHEMY_WEBHOOK_NETWORK
	) {
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
		// A prior attempt stopped while `received`. Reprocessing is safe because
		// journal, projection and ledger writes are independently idempotent.
	}
	if (getRpcUrls(env, "indexer").length === 0) {
		throw new Error("Independent indexer RPC is required to validate webhook blocks");
	}

	const network = getNetworkConfig(env.CHAIN_KEY);
	const tokenByAddress = new Map(
		network.tokens
			.filter((token) => token.address)
			.map((token) => [token.address!.toLowerCase(), token]),
	);
	const normalized = envelope.event!.activity!
		.map(normalizeActivity)
		.filter((activity): activity is NormalizedActivity => activity !== null)
		.filter((activity) =>
			tokenByAddress.has(activity.contractAddress.toLowerCase()),
		);

	for (const removed of normalized.filter((activity) => activity.removed)) {
		await handleRemovedActivity(env, removed);
	}
	const canonical = normalized.filter((activity) => !activity.removed);
	const addressUsers = await listUsersByWalletAddresses(
		env,
		canonical.flatMap((activity) => [activity.from, activity.to]),
	);
	const byWallet = new Map(
		addressUsers.map((user) => [user.walletAddress.toLowerCase(), user.uid]),
	);
	const internalSenders = new Set([
		getServerAccount(env).address.toLowerCase(),
	]);
	if (env.FAUCET_PRIVATE_KEY?.trim()) {
		internalSenders.add(getFaucetAccount(env).address.toLowerCase());
	}
	const grouped = new Map<string, NormalizedActivity[]>();
	for (const activity of canonical) {
		if (
			!byWallet.has(activity.from.toLowerCase()) &&
			!byWallet.has(activity.to.toLowerCase())
		) continue;
		const key = `${activity.blockNumber}:${activity.blockHash.toLowerCase()}`;
		const values = grouped.get(key) ?? [];
		values.push(activity);
		grouped.set(key, values);
	}

	const publicClient = getIndexerClient(env);
	let processedEvents = 0;
	for (const activities of grouped.values()) {
		const first = activities[0];
		const block = await publicClient.getBlock({
			blockHash: first.blockHash,
			includeTransactions: false,
		});
		if (
			!block.hash ||
			block.hash.toLowerCase() !== first.blockHash.toLowerCase() ||
			block.number !== first.blockNumber
		) {
			throw new Error("Webhook block failed independent RPC validation");
		}
		const finalityEvidence = await getArbitrumBlockEvidence(
			env,
			publicClient,
			{
				blockNumber: first.blockNumber,
				blockHash: first.blockHash,
			},
		);
		const observedAt = new Date().toISOString();
		const events: JournalEvent[] = [];
		const entries: LedgerEntry[] = [];
		const affected = new Map<string, Address>();

		for (const activity of activities) {
			const token = tokenByAddress.get(
				activity.contractAddress.toLowerCase(),
			)!;
			const from = activity.from.toLowerCase();
			const to = activity.to.toLowerCase();
			const fromUid = byWallet.get(from);
			const toUid = byWallet.get(to);
			const accounts: NonNullable<JournalEvent["accounts"]> = [];
			if (fromUid) {
				accounts.push({
					uid: fromUid,
					accountAddress: activity.from,
					asset: token.symbol,
					role: "from",
					deltaRaw: -activity.value,
				});
				affected.set(fromUid, activity.from);
			}
			if (toUid) {
				accounts.push({
					uid: toUid,
					accountAddress: activity.to,
					asset: token.symbol,
					role: "to",
					deltaRaw: activity.value,
				});
				affected.set(toUid, activity.to);
			}
			events.push({
				txHash: activity.txHash,
				logIndex: activity.logIndex,
				eventKind: "erc20.Transfer",
				blockNumber: activity.blockNumber,
				blockHash: activity.blockHash,
				transactionIndex: activity.transactionIndex,
				contractAddress: activity.contractAddress,
				topic0: activity.topic0,
				payload: {
					from,
					to,
					value: activity.value.toString(),
					asset: token.symbol,
					decimals: token.decimals,
				},
				source: "alchemy_address_activity",
				observedAt,
				accounts,
			});
			if (toUid && !fromUid && !internalSenders.has(from)) {
				entries.push({
					uid: toUid,
					direction: "in",
					kind: "external",
					txHash: activity.txHash,
					logIndex: activity.logIndex,
					token: token.symbol,
					amount: formatUnits(activity.value, token.decimals),
					amountRaw: activity.value.toString(),
					decimals: token.decimals,
					chainId: network.chainId,
					blockNumber: activity.blockNumber,
					blockHash: activity.blockHash,
					transactionIndex: activity.transactionIndex,
					consistencyLevel: finalityEvidence.consistencyLevel,
					projectionVersion: 1,
					counterparty: from,
					reference: "Depósito recibido",
					createdAt: new Date(Number(block.timestamp) * 1_000).toISOString(),
				});
			}
		}
		const journalBlock = {
			chainId: network.chainId,
			blockNumber: first.blockNumber,
			blockHash: first.blockHash,
			parentHash: block.parentHash,
			timestamp: block.timestamp,
			consistencyLevel: finalityEvidence.consistencyLevel,
			source: "alchemy_address_activity",
			observedAt,
			l1BatchNumber: finalityEvidence.l1BatchNumber,
			l1Confirmations: finalityEvidence.l1Confirmations,
		};
		await journalBlockEvents(env, {
			stream: `alchemy_address_activity:${network.chainId}`,
			block: journalBlock,
			events,
		});
		const projection = await projectBalanceDeltas(env, {
			block: journalBlock,
			events,
		});
		if (entries.length > 0) {
			await writeLedgerEntries(env, entries, {
				userEvents: entries.map((entry) => ({
					dedupeKey: `${chainEventId(
						network.chainId,
						entry.txHash,
						entry.logIndex ?? 0,
						"erc20.Transfer",
					)}:${entry.uid}:deposit-received`,
					uid: entry.uid,
					eventType: "activity.deposit_received",
					priority: 1,
					payload: {
					title: "Recibiste un depósito",
					body: "Abre Parmelia para ver el movimiento confirmado.",
					link: "/",
					},
				})),
			});
		}
		for (const [uid, accountAddress] of affected) {
			if (
				projection.eventOnlySatisfiedAccounts.has(
					balanceProjectionAccountKey(uid, accountAddress),
				)
			) {
				continue;
			}
			await requestBalanceRefresh(env, {
				uid,
				accountAddress,
				chainId: network.chainId,
				reason: "alchemy_address_activity",
				priority: 1,
				notBeforeBlock: first.blockNumber.toString(),
			});
		}
		processedEvents += events.length;
	}

	await finishSourceDelivery(
		env,
		"alchemy",
		envelope.id!,
		"processed",
		processedEvents,
	);
	logInfo("alchemy_webhook_processed", {
		deliveryId: envelope.id!,
		activities: envelope.event!.activity!.length,
		events: processedEvents,
		removed: normalized.length - canonical.length,
	});
	return {
		status: "processed",
		deliveryId: envelope.id!,
		events: processedEvents,
	};
}

export const __test = {
	normalizeActivity,
	parseEnvelope,
};

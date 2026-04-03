import {
	createPublicClient,
	formatUnits,
	http,
	parseAbiItem,
	type Address,
	type PublicClient,
} from "viem";
import { USDC_ADDRESS, USDC_DECIMALS } from "../../../shared";
import { getActiveChain } from "../chain";
import { getNetworkConfig } from "../../../shared/networks";

export type ChainHistoryItem = {
	direction: "sent" | "received";
	txHash: string;
	amount: string;
	currency: string;
	counterparty: string;
	createdAt: string;
	source: "token-transfer" | "transaction" | "internal-transaction";
};

type BlockscoutAddressLike =
	| string
	| {
			hash?: string;
	  };

type FetchWalletHistoryOptions = {
	chainKey?: string;
	rpcUrl?: string;
};

const ERC20_TRANSFER_EVENT = parseAbiItem(
	"event Transfer(address indexed from, address indexed to, uint256 value)",
);
// Alchemy's free Monad RPC limits eth_getLogs to 10 blocks per request.
// We therefore keep a very small recent scan window and rely on D1 for app-level history.
const RPC_HISTORY_SCAN_BLOCKS = 100n;
const RPC_LOG_CHUNK_SIZE = 10n;

class HistoryRequestError extends Error {
	status: number;
	responseBody: string;

	constructor(status: number, responseBody: string) {
		const detail = responseBody.trim();
		super(
			detail
				? `History request failed: ${status} ${detail.slice(0, 200)}`
				: `History request failed: ${status}`,
		);
		this.name = "HistoryRequestError";
		this.status = status;
		this.responseBody = responseBody;
	}
}

function trimTrailingSlash(value: string) {
	return value.replace(/\/+$/, "");
}

function normalizeAddress(value: unknown): string {
	if (!value) return "";
	if (typeof value === "string") return value.toLowerCase();
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of ["hash", "address", "from", "to", "owner"]) {
			const candidate = record[key];
			if (typeof candidate === "string") return candidate.toLowerCase();
		}
	}
	return "";
}

function getAddress(value: unknown): string {
	if (!value) return "";
	if (typeof value === "string") return value;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const key of ["hash", "address", "from", "to", "owner"]) {
			const candidate = record[key];
			if (typeof candidate === "string") return candidate;
		}
	}
	return "";
}

function safeBigInt(value: unknown): bigint {
	try {
		if (typeof value === "bigint") return value;
		if (typeof value === "number") return BigInt(value);
		if (typeof value === "string" && value.trim() && !value.includes(".")) {
			return BigInt(value);
		}
	} catch {
		// ignore malformed values
	}
	return 0n;
}

function pushUnique(target: ChainHistoryItem[], item: ChainHistoryItem, seen: Set<string>) {
	const key = [item.direction, item.txHash, item.currency, item.amount, item.counterparty, item.source].join(":");
	if (seen.has(key)) return;
	seen.add(key);
	target.push(item);
}

async function fetchJson(url: string, init?: RequestInit) {
	const res = await fetch(url, init);
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new HistoryRequestError(res.status, body);
	}
	return (await res.json()) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function firstArray(value: unknown, depth = 0): Record<string, unknown>[] {
	if (depth > 4) return [];
	if (Array.isArray(value)) {
		return value.filter((item): item is Record<string, unknown> => !!asRecord(item));
	}
	const record = asRecord(value);
	if (!record) return [];

	for (const key of [
		"items",
		"list",
		"rows",
		"records",
		"data",
		"result",
		"activities",
		"transactions",
	]) {
		if (key in record) {
			const nested = firstArray(record[key], depth + 1);
			if (nested.length > 0) return nested;
		}
	}

	for (const nestedValue of Object.values(record)) {
		const nested = firstArray(nestedValue, depth + 1);
		if (nested.length > 0) return nested;
	}

	return [];
}

function firstString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value;
	}
	return "";
}

function firstNumber(...values: unknown[]): number | null {
	for (const value of values) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && value.trim()) {
			const parsed = Number(value);
			if (Number.isFinite(parsed)) return parsed;
		}
	}
	return null;
}

function getNested(record: Record<string, unknown>, path: string[]): unknown {
	let current: unknown = record;
	for (const key of path) {
		const next = asRecord(current);
		if (!next || !(key in next)) return undefined;
		current = next[key];
	}
	return current;
}

function resolveDirection(record: Record<string, unknown>, normalizedWallet: string) {
	const explicitDirection = firstString(
		record.direction,
		record.flow,
		record.side,
		record.transferType,
		record.type,
	);
	const normalizedExplicit = explicitDirection.toLowerCase();
	if (["send", "sent", "out", "outgoing"].includes(normalizedExplicit)) return "sent";
	if (["receive", "received", "in", "incoming"].includes(normalizedExplicit)) return "received";

	const from = normalizeAddress(
		record.from ??
			record.fromAddress ??
			record.sender ??
			getNested(record, ["transaction", "from"]) ??
			getNested(record, ["tx", "from"]),
	);
	const to = normalizeAddress(
		record.to ??
			record.toAddress ??
			record.receiver ??
			getNested(record, ["transaction", "to"]) ??
			getNested(record, ["tx", "to"]),
	);

	if (from === normalizedWallet) return "sent";
	if (to === normalizedWallet) return "received";
	return null;
}

function formatAmount(rawValue: unknown, decimals: number) {
	if (typeof rawValue === "string" && rawValue.includes(".")) return rawValue;
	const raw = safeBigInt(rawValue);
	if (raw <= 0n) return "";
	return formatUnits(raw, decimals);
}

function parseHistoryRecord(
	record: Record<string, unknown>,
	normalizedWallet: string,
	nativeTokenSymbol: string,
	source: ChainHistoryItem["source"],
): ChainHistoryItem | null {
	const direction = resolveDirection(record, normalizedWallet);
	if (!direction) return null;

	const txHash = firstString(
		record.txHash,
		record.transactionHash,
		record.tx_hash,
		record.hash,
		getNested(record, ["transaction", "hash"]),
		getNested(record, ["tx", "hash"]),
	);
	if (!txHash) return null;

	const from = record.from ?? record.fromAddress ?? record.sender ?? getNested(record, ["transaction", "from"]);
	const to = record.to ?? record.toAddress ?? record.receiver ?? getNested(record, ["transaction", "to"]);
	const counterparty = direction === "sent" ? getAddress(to) : getAddress(from);

	const decimals =
		firstNumber(
			record.decimals,
			record.tokenDecimals,
			record.tokenDecimal,
			getNested(record, ["token", "decimals"]),
			getNested(record, ["asset", "decimals"]),
			getNested(record, ["currency", "decimals"]),
		) ?? 18;

	const currency = firstString(
		record.symbol,
		record.tokenSymbol,
		getNested(record, ["token", "symbol"]),
		getNested(record, ["asset", "symbol"]),
		getNested(record, ["currency", "symbol"]),
	) || nativeTokenSymbol;

	const amount = formatAmount(
		record.value ??
			record.amount ??
			record.quantity ??
			record.rawAmount ??
			record.amountRaw ??
			getNested(record, ["total", "value"]) ??
			getNested(record, ["amount", "value"]),
		decimals,
	);
	if (!amount) return null;

	return {
		direction,
		txHash,
		amount,
		currency,
		counterparty,
		createdAt:
			firstString(
				record.timestamp,
				record.blockTimestamp,
				record.block_timestamp,
				record.time,
				record.txTime,
				record.createdAt,
				getNested(record, ["transaction", "timestamp"]),
			) || new Date().toISOString(),
		source,
	};
}

async function fetchBlockscoutHistory(walletAddress: string, baseApiUrl: string, nativeTokenSymbol: string) {
	const normalizedWallet = walletAddress.toLowerCase();
	const baseUrl = `${trimTrailingSlash(baseApiUrl)}/addresses/${walletAddress}`;

	const [tokenTransfersJson, transactionsJson, internalTransactionsJson] = await Promise.all([
		fetchJson(`${baseUrl}/token-transfers?type=ERC-20`),
		fetchJson(`${baseUrl}/transactions`),
		fetchJson(`${baseUrl}/internal-transactions`),
	]);

	const history: ChainHistoryItem[] = [];
	const seen = new Set<string>();

	for (const item of firstArray(tokenTransfersJson)) {
		const token = asRecord(item.token);
		const total = asRecord(item.total);
		const from = normalizeAddress((item as { from?: BlockscoutAddressLike }).from);
		const to = normalizeAddress((item as { to?: BlockscoutAddressLike }).to);
		const txHash = firstString(item.tx_hash, item.transaction_hash);
		if (!txHash) continue;

		const direction = from === normalizedWallet ? "sent" : to === normalizedWallet ? "received" : null;
		if (!direction) continue;

		const decimals = Number(token?.decimals ?? total?.decimals ?? 18);
		const rawValue = total?.value ?? item.value ?? "0";
		const amount = formatAmount(rawValue, Number.isFinite(decimals) ? decimals : 18);
		if (!amount) continue;

		pushUnique(history, {
			direction,
			txHash,
			amount,
			currency: String(token?.symbol || "TOKEN"),
			counterparty: direction === "sent" ? getAddress(item.to) : getAddress(item.from),
			createdAt: String(item.timestamp || item.block_timestamp || new Date().toISOString()),
			source: "token-transfer",
		}, seen);
	}

	for (const item of firstArray(transactionsJson)) {
		const parsed = parseHistoryRecord(item, normalizedWallet, nativeTokenSymbol, "transaction");
		if (parsed) pushUnique(history, parsed, seen);
	}

	for (const item of firstArray(internalTransactionsJson)) {
		const parsed = parseHistoryRecord(item, normalizedWallet, nativeTokenSymbol, "internal-transaction");
		if (parsed) pushUnique(history, parsed, seen);
	}

	return history;
}

async function fetchRpcTransferLogs(
	publicClient: PublicClient,
	tokenAddress: Address,
	walletAddress: Address,
	direction: "sent" | "received",
	fromBlock: bigint,
	toBlock: bigint,
) {
	const logs: Array<{
		args: { from?: Address; to?: Address; value?: bigint };
		blockNumber: bigint | null;
		transactionHash: `0x${string}` | null;
	}> = [];

	for (let start = fromBlock; start <= toBlock; start += RPC_LOG_CHUNK_SIZE) {
		const end =
			start + RPC_LOG_CHUNK_SIZE - 1n > toBlock
				? toBlock
				: start + RPC_LOG_CHUNK_SIZE - 1n;
		const chunk = (await publicClient.getLogs({
			address: tokenAddress,
			event: ERC20_TRANSFER_EVENT,
			args:
				direction === "sent"
					? { from: walletAddress }
					: { to: walletAddress },
			fromBlock: start,
			toBlock: end,
		})) as Array<{
			args: { from?: Address; to?: Address; value?: bigint };
			blockNumber: bigint | null;
			transactionHash: `0x${string}` | null;
		}>;
		logs.push(...chunk);
	}

	return logs;
}

async function fetchRpcHistory(
	walletAddress: string,
	rpcUrl: string,
	chainKey?: string,
) {
	const publicClient = createPublicClient({
		chain: getActiveChain(chainKey),
		transport: http(rpcUrl),
	});
	const latestBlock = await publicClient.getBlockNumber();
	const fromBlock =
		latestBlock > RPC_HISTORY_SCAN_BLOCKS
			? latestBlock - RPC_HISTORY_SCAN_BLOCKS
			: 0n;
	const normalizedWallet = walletAddress.toLowerCase();
	const wallet = walletAddress as Address;

	const [sentLogs, receivedLogs] = await Promise.all([
		fetchRpcTransferLogs(
			publicClient,
			USDC_ADDRESS as Address,
			wallet,
			"sent",
			fromBlock,
			latestBlock,
		),
		fetchRpcTransferLogs(
			publicClient,
			USDC_ADDRESS as Address,
			wallet,
			"received",
			fromBlock,
			latestBlock,
		),
	]);

	const blockNumbers = Array.from(
		new Set(
			[...sentLogs, ...receivedLogs]
				.map((log) => log.blockNumber)
				.filter((value): value is bigint => value !== null),
		),
	);
	const blockTimestampMap = new Map<string, string>();
	await Promise.all(
		blockNumbers.map(async (blockNumber) => {
			const block = await publicClient.getBlock({ blockNumber });
			blockTimestampMap.set(
				blockNumber.toString(),
				new Date(Number(block.timestamp) * 1000).toISOString(),
			);
		}),
	);

	const history: ChainHistoryItem[] = [];
	const seen = new Set<string>();

	for (const [direction, logs] of [
		["sent", sentLogs],
		["received", receivedLogs],
	] as const) {
		for (const log of logs) {
			if (!log.transactionHash || !log.blockNumber) continue;
			const rawAmount = log.args.value ?? 0n;
			if (rawAmount <= 0n) continue;

			const counterparty =
				direction === "sent"
					? String(log.args.to ?? "")
					: String(log.args.from ?? "");
			if (!counterparty || counterparty.toLowerCase() === normalizedWallet) continue;

			pushUnique(
				history,
				{
					direction,
					txHash: log.transactionHash,
					amount: formatUnits(rawAmount, USDC_DECIMALS),
					currency: "USDC",
					counterparty,
					createdAt:
						blockTimestampMap.get(log.blockNumber.toString()) ??
						new Date().toISOString(),
					source: "token-transfer",
				},
				seen,
			);
		}
	}

	return history;
}

async function fetchMonadscanHistory(walletAddress: string, baseApiUrl: string, nativeTokenSymbol: string) {
	const normalizedWallet = walletAddress.toLowerCase();
	const baseUrl = trimTrailingSlash(baseApiUrl);

	const [tokenTransfersJson, transactionsJson] = await Promise.all([
		fetchJson(`${baseUrl}?module=account&action=tokentx&address=${walletAddress}&sort=desc`),
		fetchJson(`${baseUrl}?module=account&action=txlist&address=${walletAddress}&sort=desc`)
	]);

	const history: ChainHistoryItem[] = [];
	const seen = new Set<string>();

	for (const item of firstArray((tokenTransfersJson as Record<string, unknown>)?.result)) {
		const from = normalizeAddress(item.from);
		const to = normalizeAddress(item.to);
		const txHash = firstString(item.hash);
		if (!txHash) continue;

		const direction = from === normalizedWallet ? "sent" : to === normalizedWallet ? "received" : null;
		if (!direction) continue;

		const decimals = Number(item.tokenDecimal ?? 18);
		const rawValue = item.value ?? "0";
		const amount = formatAmount(rawValue, Number.isFinite(decimals) ? decimals : 18);
		if (!amount) continue;

		pushUnique(history, {
			direction,
			txHash,
			amount,
			currency: String(item.tokenSymbol || "TOKEN"),
			counterparty: direction === "sent" ? getAddress(item.to) : getAddress(item.from),
			createdAt: String(item.timeStamp ? new Date(Number(item.timeStamp) * 1000).toISOString() : new Date().toISOString()),
			source: "token-transfer",
		}, seen);
	}

	for (const item of firstArray((transactionsJson as Record<string, unknown>)?.result)) {
		// Convert Etherscan format to the common format parseHistoryRecord expects or just parse manually
		const from = normalizeAddress(item.from);
		const to = normalizeAddress(item.to);
		const txHash = firstString(item.hash);
		if (!txHash) continue;
		
		const direction = from === normalizedWallet ? "sent" : to === normalizedWallet ? "received" : null;
		if (!direction) continue;

		const rawValue = item.value ?? "0";
		if (safeBigInt(rawValue) <= 0n) continue; // Only want value transfers
		
		const amount = formatAmount(rawValue, 18);
		if (!amount) continue;

		pushUnique(history, {
			direction,
			txHash,
			amount,
			currency: nativeTokenSymbol,
			counterparty: direction === "sent" ? getAddress(item.to) : getAddress(item.from),
			createdAt: String(item.timeStamp ? new Date(Number(item.timeStamp) * 1000).toISOString() : new Date().toISOString()),
			source: "transaction",
		}, seen);
	}

	return history;
}

export async function fetchWalletHistory(
	walletAddress: string,
	options: FetchWalletHistoryOptions = {},
): Promise<ChainHistoryItem[]> {
	const network = getNetworkConfig(options.chainKey);

	if (network.historyProvider === "rpc") {
		if (!options.rpcUrl) {
			throw new Error("RPC_URL is not configured");
		}
		return fetchRpcHistory(walletAddress, options.rpcUrl, options.chainKey);
	}

	if (!network.historyApiBaseUrl) {
		throw new Error(`No history API configured for ${network.name}`);
	}

	if (network.historyProvider === "monadscan") {
		return fetchMonadscanHistory(
			walletAddress,
			network.historyApiBaseUrl,
			network.nativeTokenSymbol,
		);
	}

	return fetchBlockscoutHistory(
		walletAddress,
		network.historyApiBaseUrl,
		network.nativeTokenSymbol,
	);
}

export function describeHistoryError(error: unknown) {
	if (error instanceof HistoryRequestError) {
		return error.message;
	}
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

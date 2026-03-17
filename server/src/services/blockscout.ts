import { formatEther, formatUnits } from "viem";

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

function normalizeAddress(value: BlockscoutAddressLike | null | undefined): string {
	if (!value) return "";
	if (typeof value === "string") return value.toLowerCase();
	return typeof value.hash === "string" ? value.hash.toLowerCase() : "";
}

function getAddress(value: BlockscoutAddressLike | null | undefined): string {
	if (!value) return "";
	if (typeof value === "string") return value;
	return typeof value.hash === "string" ? value.hash : "";
}

function safeBigInt(value: unknown): bigint {
	try {
		if (typeof value === "bigint") return value;
		if (typeof value === "number") return BigInt(value);
		if (typeof value === "string" && value.trim()) return BigInt(value);
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

async function fetchItems(url: string): Promise<any[]> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`Blockscout request failed: ${res.status}`);
	}
	const data = (await res.json()) as { items?: any[] };
	return Array.isArray(data.items) ? data.items : [];
}

export async function fetchWalletHistory(walletAddress: string): Promise<ChainHistoryItem[]> {
	const normalizedWallet = walletAddress.toLowerCase();
	const baseUrl = `https://base-sepolia.blockscout.com/api/v2/addresses/${walletAddress}`;

	const [tokenTransfers, transactions, internalTransactions] = await Promise.all([
		fetchItems(`${baseUrl}/token-transfers?type=ERC-20`),
		fetchItems(`${baseUrl}/transactions`),
		fetchItems(`${baseUrl}/internal-transactions`),
	]);

	const history: ChainHistoryItem[] = [];
	const seen = new Set<string>();

	for (const item of tokenTransfers) {
		const from = normalizeAddress(item.from);
		const to = normalizeAddress(item.to);
		const txHash = String(item.tx_hash || item.transaction_hash || "");
		if (!txHash) continue;

		const direction = from === normalizedWallet ? "sent" : to === normalizedWallet ? "received" : null;
		if (!direction) continue;

		const decimals = Number(item.token?.decimals ?? item.total?.decimals ?? 18);
		const rawValue = item.total?.value ?? item.value ?? "0";
		const amount = formatUnits(safeBigInt(rawValue), Number.isFinite(decimals) ? decimals : 18);
		const counterparty = direction === "sent" ? getAddress(item.to) : getAddress(item.from);

		pushUnique(history, {
			direction,
			txHash,
			amount,
			currency: String(item.token?.symbol || "TOKEN"),
			counterparty,
			createdAt: String(item.timestamp || item.block_timestamp || new Date().toISOString()),
			source: "token-transfer",
		}, seen);
	}

	for (const item of transactions) {
		const from = normalizeAddress(item.from);
		const to = normalizeAddress(item.to);
		const txHash = String(item.hash || item.tx_hash || item.transaction_hash || "");
		const value = safeBigInt(item.value);
		if (!txHash || value <= 0n) continue;

		const direction = from === normalizedWallet ? "sent" : to === normalizedWallet ? "received" : null;
		if (!direction) continue;

		const counterparty = direction === "sent" ? getAddress(item.to) : getAddress(item.from);

		pushUnique(history, {
			direction,
			txHash,
			amount: formatEther(value),
			currency: "ETH",
			counterparty,
			createdAt: String(item.timestamp || item.block_timestamp || new Date().toISOString()),
			source: "transaction",
		}, seen);
	}

	for (const item of internalTransactions) {
		const from = normalizeAddress(item.from);
		const to = normalizeAddress(item.to);
		const txHash = String(item.transaction_hash || item.hash || item.tx_hash || "");
		const value = safeBigInt(item.value);
		if (!txHash || value <= 0n) continue;

		const direction = from === normalizedWallet ? "sent" : to === normalizedWallet ? "received" : null;
		if (!direction) continue;

		const counterparty = direction === "sent" ? getAddress(item.to) : getAddress(item.from);

		pushUnique(history, {
			direction,
			txHash,
			amount: formatEther(value),
			currency: "ETH",
			counterparty,
			createdAt: String(item.timestamp || item.block_timestamp || new Date().toISOString()),
			source: "internal-transaction",
		}, seen);
	}

	return history.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

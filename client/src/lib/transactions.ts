// Shared transaction model + parsing for Home and Extractos.

export interface Transaction {
	type: "sent" | "received";
	txHash: string;
	amount: string;
	currency: string;
	to?: string;
	reference?: string;
	createdAt: string;
	/** "link" = collected via payment link; "transfer" = direct movement. */
	kind?: "link" | "transfer";
}

/** Merge + sort the /user/transactions payload into a single timeline. */
export function parseTransactions(txData: any): Transaction[] {
	if (!txData) return [];
	const sent = (txData.sent || []).map((t: any) => ({
		type: "sent" as const,
		txHash: t.txHash,
		amount: t.amount,
		currency: t.currency,
		to: t.to,
		createdAt: t.createdAt,
		kind: t.kind ?? "transfer",
	}));
	const received = (txData.received || []).map((t: any) => ({
		type: "received" as const,
		txHash: t.txHash,
		amount: t.amount,
		currency: t.currency,
		reference: t.reference,
		createdAt: t.createdAt,
		kind: t.kind ?? "transfer",
	}));
	return [...sent, ...received].sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);
}

export function formatShortDate(iso: string) {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString("es", { day: "numeric", month: "short" });
}

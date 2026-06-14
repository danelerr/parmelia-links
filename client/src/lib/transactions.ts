// Shared transaction model + parsing for Home and Extractos.

import i18n from "./i18n";

export interface Transaction {
	type: "sent" | "received";
	txHash: string;
	amount: string;
	currency: string;
	to?: string;
	reference?: string;
	createdAt: string;
	/** Ledger kind: payment, link (cobro), swap, fund (faucet), external (depósito). */
	kind?: string;
}

/** Human label for a movement row. */
export function txLabel(t: Transaction): string {
	if (t.kind === "swap") return t.reference || i18n.t("tx.swap");
	if (t.type === "received") {
		return t.reference || (t.kind === "external" ? i18n.t("tx.depositReceived") : i18n.t("tx.chargeReceived"));
	}
	return i18n.t("tx.paymentSent");
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
		reference: t.reference,
		createdAt: t.createdAt,
		kind: t.kind ?? "payment",
	}));
	const received = (txData.received || []).map((t: any) => ({
		type: "received" as const,
		txHash: t.txHash,
		amount: t.amount,
		currency: t.currency,
		reference: t.reference,
		createdAt: t.createdAt,
		kind: t.kind ?? "payment",
	}));
	return [...sent, ...received].sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);
}

export function formatShortDate(iso: string) {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(i18n.resolvedLanguage || i18n.language || "es", {
		day: "numeric",
		month: "short",
	});
}

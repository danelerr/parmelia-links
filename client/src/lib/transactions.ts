// Shared transaction model + parsing for Home and Extractos.

import i18n from "./i18n";
import { formatDate } from "./format";

export interface Transaction {
	/** Stable, list-unique key (movement signature + position). */
	id: string;
	type: "sent" | "received";
	txHash: string;
	amount: string;
	currency: string;
	/** Destination wallet (set on sent movements). */
	to?: string;
	/** Origin wallet — who the money came from (set on received movements). */
	from?: string;
	reference?: string;
	createdAt: string;
	/** Ledger kind: payment, link (cobro), swap, fund (faucet), external (depósito), earn (ahorro). */
	kind?: string;
}

/** Human label for a movement row. */
export function txLabel(t: Transaction): string {
	if (t.kind === "swap") return t.reference || i18n.t("tx.swap");
	if (t.kind === "earn") {
		return t.reference || (t.type === "received" ? i18n.t("tx.earnWithdraw") : i18n.t("tx.earnDeposit"));
	}
	if (t.type === "received") {
		return t.reference || (t.kind === "external" ? i18n.t("tx.depositReceived") : i18n.t("tx.chargeReceived"));
	}
	return i18n.t("tx.paymentSent");
}

/** Raw ledger row as returned by GET /user/transactions (loosely typed). */
interface RawLedgerRow {
	txHash?: string;
	amount?: string;
	currency?: string;
	to?: string;
	paidBy?: string;
	reference?: string;
	createdAt?: string;
	kind?: string;
}

interface RawTxPayload {
	sent?: RawLedgerRow[];
	received?: RawLedgerRow[];
}

/** Merge + sort the /user/transactions payload into a single timeline. */
export function parseTransactions(txData: RawTxPayload | null | undefined): Transaction[] {
	if (!txData) return [];
	const sent: Transaction[] = (txData.sent || []).map((t) => ({
		id: "",
		type: "sent" as const,
		txHash: t.txHash ?? "",
		amount: t.amount ?? "0",
		currency: t.currency ?? "",
		to: t.to,
		reference: t.reference,
		createdAt: t.createdAt ?? "",
		kind: t.kind ?? "payment",
	}));
	const received: Transaction[] = (txData.received || []).map((t) => ({
		id: "",
		type: "received" as const,
		txHash: t.txHash ?? "",
		amount: t.amount ?? "0",
		currency: t.currency ?? "",
		// Server sends the origin wallet as `paidBy` on incoming movements.
		from: t.paidBy,
		reference: t.reference,
		createdAt: t.createdAt ?? "",
		kind: t.kind ?? "payment",
	}));
	const merged = [...sent, ...received].sort(
		(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
	);

	// Collapse the same on-chain movement recorded twice. The welcome/faucet
	// deposit is written by the app at fund time AND historically re-ingested by
	// the on-chain indexer as an "external" transfer; both rows share the same
	// (type, tx, token, amount). Keep one, preferring the app-recorded entry
	// (kind !== "external") for the more precise label.
	const byMovement = new Map<string, Transaction>();
	for (const tx of merged) {
		const sig = `${tx.type}|${tx.txHash}|${tx.currency}|${tx.amount}`;
		const existing = byMovement.get(sig);
		if (!existing) {
			byMovement.set(sig, tx);
		} else if (existing.kind === "external" && tx.kind !== "external") {
			byMovement.set(sig, tx);
		}
	}

	// Assign a list-unique, stable id (signature + position) so React never sees
	// duplicate keys even if two genuinely distinct movements share a tx hash.
	return [...byMovement.values()].map((tx, i) => ({
		...tx,
		id: `${tx.type}:${tx.txHash}:${tx.currency}:${i}`,
	}));
}

export function formatShortDate(iso: string) {
	return formatDate(iso, { day: "numeric", month: "short" });
}

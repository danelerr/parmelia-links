// Receipt modal — GatoPago Milk paper with a formal, legible money hierarchy.
// info at the bottom (fecha, hora, N° de comprobante = tx hash). Portaled to
// <body> so position:fixed stays viewport-relative under transformed pages.

import { useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { notifyError } from "../lib/notify";
import Logo from "./Logo";
import { getKnownExplorerTxUrl } from "../lib/activeNetwork";
import { formatAmount, formatDate, formatTime } from "../lib/format";
import { downloadCard } from "../lib/exportCard";
import { useDialog } from "../hooks/useDialog";
import type { Transaction } from "../lib/transactions";
import { readMigratedStorage } from "../lib/storageMigration";

function shortHash(hash: string) {
	return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

export default function ReceiptModal({
	tx,
	onClose,
}: {
	tx: Transaction;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const cardRef = useRef<HTMLDivElement>(null);
	const dialogRef = useDialog<HTMLDivElement>(onClose);
	const received = tx.type === "received";
	const swapped = tx.kind === "swap";
	// The other party: origin wallet on received, destination wallet on sent.
	const counterparty = swapped ? null : received ? tx.from : tx.to;
	const date = new Date(tx.createdAt);
	const hasDate = !Number.isNaN(date.getTime());
	// Same privacy mode as Home: amounts stay masked while "hide balance" is on.
	const hideBalance = readMigratedStorage("gatopago:hideBalance", "parmelia:hideBalance") === "1";
	const explorerUrl = tx.txHash ? getKnownExplorerTxUrl(tx.txHash, tx.chainKey) : null;

	return createPortal(
		<div
			className="dialog-backdrop fixed inset-0 z-50 flex flex-col items-center justify-center gap-4 px-5 animate-fade-in"
			onClick={onClose}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="receipt-title"
				tabIndex={-1}
				className="w-full max-w-sm flex flex-col items-center gap-4"
				onClick={(e) => e.stopPropagation()}
			>
			<div
				ref={cardRef}
				className="receipt-paper relative flex w-full flex-col items-center overflow-hidden p-8 animate-pixel-in"
			>
				<div className="receipt-rail absolute inset-x-0 top-0 h-2" />

				<div className="flex items-center gap-2 mb-6 relative z-1">
					<Logo className="w-6" />
					<span className="font-display text-[16px] text-paper-text">GatoPago</span>
				</div>
				<div className="relative z-1 mb-5 flex h-14 w-14 items-center justify-center border-2 border-paper-text bg-growth/25 text-paper-text">
					<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
						<polyline points="20 6 9 17 4 12" />
					</svg>
				</div>
				<p id="receipt-title" className="relative z-1 mb-1 text-[14px] text-paper-muted">
					{swapped ? t("receipt.swapped") : received ? t("receipt.received") : t("receipt.sent")}
				</p>
				<p className="type-mono relative z-1 mb-4 max-w-full break-words text-center text-[40px] font-bold leading-tight text-paper-text">
					{hideBalance ? (
						"••••"
					) : (
						<>
							{received ? "+" : "−"}
							{formatAmount(tx.amount, tx.currency)}
							<span className="ml-1.5 text-[20px] text-paper-muted">{tx.currency}</span>
						</>
					)}
				</p>
				{counterparty && (
					<div className="flex items-center justify-center gap-2 mb-1 relative z-1">
						<span className="text-[11px] uppercase tracking-[0.08em] text-paper-muted">
							{received ? t("receipt.from") : t("receipt.to")}
						</span>
						<span className="border border-paper-border bg-paper-2 px-2.5 py-0.5 font-mono text-[13px] text-paper-muted">
							{counterparty.slice(0, 6)}…{counterparty.slice(-4)}
						</span>
					</div>
				)}
				{tx.reference && (
					<p className="relative z-1 mb-1 text-center text-[14px] text-paper-muted">{tx.reference}</p>
				)}

				{/* Formal receipt info */}
				<div className="relative z-1 mt-5 flex w-full flex-col gap-1.5 border border-paper-border bg-paper-2 px-4 py-3">
					{hasDate && (
						<>
							<div className="flex items-center justify-between text-[12px]">
								<span className="text-paper-muted">{t("common.date")}</span>
								<span className="text-paper-text">{formatDate(date)}</span>
							</div>
							<div className="flex items-center justify-between text-[12px]">
								<span className="text-paper-muted">{t("common.time")}</span>
								<span className="text-paper-text">{formatTime(date)}</span>
							</div>
						</>
					)}
					{tx.txHash && (
						<div className="flex items-center justify-between text-[12px] gap-3">
							<span className="shrink-0 text-paper-muted">{t("receipt.receiptNo")}</span>
							<span className="truncate font-mono text-paper-text">{shortHash(tx.txHash)}</span>
						</div>
					)}
					{explorerUrl && (
						<a
							href={explorerUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="mt-2 text-center text-[12px] font-semibold text-cat-700 underline underline-offset-2"
						>
							{t("receipt.viewOnNetwork")}
						</a>
					)}
					{tx.networkName && (
						<div className="flex items-center justify-between text-[12px] gap-3">
							<span className="shrink-0 text-paper-muted">{t("signing.network")}</span>
							<span className="text-right text-paper-text">{tx.networkName}</span>
						</div>
					)}
					<p className="mt-1 text-center text-[11px] text-paper-muted">GatoPago · Comprobante</p>
				</div>
			</div>

			<div className="flex gap-3 w-full">
				<button
					onClick={async () => {
						try {
							await downloadCard(cardRef.current, `gatopago-${tx.amount}-${tx.currency}.png`);
						} catch (err) {
							notifyError(err, t("receipt.downloadError"));
						}
					}}
					className="btn btn-primary flex-1 min-w-0"
				>
					{t("receipt.download")}
				</button>
				<button onClick={onClose} className="btn btn-ghost shrink-0">
					{t("common.close")}
				</button>
			</div>
			</div>
		</div>,
		document.body,
	);
}

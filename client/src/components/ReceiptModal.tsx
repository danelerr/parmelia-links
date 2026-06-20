// Receipt modal - a brand piece (gradient bar + glow) with the formal receipt
// info at the bottom (fecha, hora, N° de comprobante = tx hash). Portaled to
// <body> so position:fixed stays viewport-relative under transformed pages.

import { useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { notifyError } from "../lib/notify";
import Logo from "./Logo";
import i18n from "../lib/i18n";
import { getExplorerTxUrl } from "../lib/activeNetwork";
import { formatAmount } from "../lib/format";
import { downloadCard } from "../lib/exportCard";
import type { Transaction } from "../lib/transactions";

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
	const received = tx.type === "received";
	// The other party: origin wallet on received, destination wallet on sent.
	const counterparty = received ? tx.from : tx.to;
	const date = new Date(tx.createdAt);
	const hasDate = !Number.isNaN(date.getTime());

	return createPortal(
		<div
			className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center px-5 gap-4 animate-fade-in"
			onClick={onClose}
		>
			<div
				ref={cardRef}
				className="relative overflow-hidden w-full max-w-sm bg-surface border border-border rounded-[24px] p-8 flex flex-col items-center shadow-e3"
				onClick={(e) => e.stopPropagation()}
			>
				<div
					className="absolute top-0 left-0 right-0 h-1"
					style={{ background: "linear-gradient(100deg,#9ce3f4,#f4a9cf 52%,#efe08c)" }}
				/>
				<div
					className="pointer-events-none absolute -top-20 -left-16 w-48 h-48 rounded-full opacity-[0.14] blur-2xl"
					style={{
						background: received
							? "radial-gradient(circle,#9ce3f4,transparent 70%)"
							: "radial-gradient(circle,#f4a9cf,transparent 70%)",
					}}
				/>

				<div className="flex items-center gap-2 mb-6 relative z-1">
					<Logo className="w-6" />
					<span className="font-display text-[16px]">Parmelia</span>
				</div>
				<div
					className="w-14 h-14 rounded-full flex items-center justify-center mb-5 relative z-1"
					style={{
						background: received ? "rgba(156,227,244,0.16)" : "rgba(244,169,207,0.16)",
					}}
				>
					<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={received ? "#9ce3f4" : "#f4a9cf"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
						<polyline points="20 6 9 17 4 12" />
					</svg>
				</div>
				<p className="text-[14px] text-text-muted mb-1 relative z-1">
					{received ? t("receipt.received") : t("receipt.sent")}
				</p>
				<p className="font-display text-[40px] leading-tight mb-4 tabular relative z-1 max-w-full break-words text-center">
					{received ? "+" : "−"}
					{formatAmount(tx.amount, tx.currency)}
					<span className="text-text-muted text-[20px] ml-1.5">{tx.currency}</span>
				</p>
				{counterparty && (
					<div className="flex items-center justify-center gap-2 mb-1 relative z-1">
						<span className="text-[11px] uppercase tracking-[0.08em] text-text-faint">
							{received ? t("receipt.from") : t("receipt.to")}
						</span>
						<span className="text-[13px] font-mono text-text-muted bg-surface-2 rounded-full px-2.5 py-0.5">
							{counterparty.slice(0, 6)}…{counterparty.slice(-4)}
						</span>
					</div>
				)}
				{tx.reference && (
					<p className="text-text-muted text-[14px] text-center mb-1 relative z-1">{tx.reference}</p>
				)}

				{/* Formal receipt info */}
				<div className="w-full border-t border-border mt-5 pt-4 relative z-1 flex flex-col gap-1.5">
					{hasDate && (
						<>
							<div className="flex items-center justify-between text-[12px]">
								<span className="text-text-faint">{t("common.date")}</span>
								<span className="text-text-muted">
									{date.toLocaleDateString(i18n.resolvedLanguage || "es", { day: "numeric", month: "long", year: "numeric" })}
								</span>
							</div>
							<div className="flex items-center justify-between text-[12px]">
								<span className="text-text-faint">{t("common.time")}</span>
								<span className="text-text-muted">
									{date.toLocaleTimeString(i18n.resolvedLanguage || "es", { hour: "2-digit", minute: "2-digit" })}
								</span>
							</div>
						</>
					)}
					{tx.txHash && (
						<div className="flex items-center justify-between text-[12px] gap-3">
							<span className="text-text-faint shrink-0">{t("receipt.receiptNo")}</span>
							<span className="text-text-muted font-mono truncate">{shortHash(tx.txHash)}</span>
						</div>
					)}
					{tx.txHash && (
						<a
							href={getExplorerTxUrl(tx.txHash)}
							target="_blank"
							rel="noopener noreferrer"
							className="text-text-faint hover:text-text-muted text-[12px] text-center mt-2 transition-colors"
						>
							{t("receipt.viewOnNetwork")}
						</a>
					)}
					<p className="text-[11px] text-text-faint text-center mt-1">parmelia.me</p>
				</div>
			</div>

			<div className="flex gap-3 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
				<button
					onClick={async () => {
						try {
							await downloadCard(cardRef.current, `parmelia-${tx.amount}-${tx.currency}.png`);
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
		</div>,
		document.body,
	);
}

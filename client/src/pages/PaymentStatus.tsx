import { useSearchParams } from "react-router-dom";
import { useRef } from "react";
import Logo from "../components/Logo";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import { IconCheck, IconCross, Spinner } from "../components/icons";
import type { User } from "../lib/firebase";
import { activeNetwork, getExplorerTxUrl } from "../lib/activeNetwork";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { usePaymentStatus } from "../hooks/usePaymentStatus";
import { useTranslation } from "react-i18next";
import { formatAmount, formatDate, formatTime } from "../lib/format";
import { downloadCard, shareCard } from "../lib/exportCard";

export default function PaymentStatus({ user }: { user: User | null }) {
	const [searchParams] = useSearchParams();
	const navigate = useViewTransitionNavigate();
	const { t } = useTranslation();
	const cardRef = useRef<HTMLDivElement>(null);
	const amount = searchParams.get("amount");
	const currency = searchParams.get("currency");
	const to = searchParams.get("to");

	// A payment arrives here unconfirmed (202 accepted broadcast or a
	// duplicate submit). We poll its lifecycle and flip this same screen from
	// "in progress" to the receipt (or to a calm failure) when it settles.
	const pendingParam = searchParams.get("pending") === "1";
	const userOpHash = searchParams.get("uoh");
	const poll = usePaymentStatus(pendingParam ? user : null, pendingParam ? userOpHash : null);
	const failed = pendingParam && poll.status === "failed";
	const confirmed = !pendingParam || poll.status === "confirmed";
	const pending = !confirmed && !failed;
	const txHash = searchParams.get("tx") || poll.txHash;

	const toLabel = to
		? to.startsWith("0x")
			? `${to.slice(0, 6)}…${to.slice(-4)}`
			: `@${to}`
		: null;

	async function handleDownload() {
		try {
			await downloadCard(cardRef.current, `parmelia-pago-${amount}-${currency}.png`);
		} catch {
			/* ignore */
		}
	}

	async function handleShare() {
		await shareCard(cardRef.current, {
			filename: `parmelia-pago-${amount}-${currency}.png`,
			text: t("paymentStatus.shareText", { amount, currency }),
			url: txHash ? getExplorerTxUrl(txHash) : undefined,
		});
	}

	return (
		<Screen>
			<BackHeader onClick={() => navigate("/")} ariaLabel={t("pay.goHome")} className="" />
			<div className="flex-1 flex flex-col justify-center">
				<div
					ref={cardRef}
					className="relative overflow-hidden bg-surface border border-border rounded-[24px] p-8 flex flex-col items-center shadow-e2"
				>
					<div
						className="absolute top-0 left-0 right-0 h-1"
						style={{ background: "linear-gradient(100deg,#9ce3f4,#f4a9cf 52%,#efe08c)" }}
					/>
					<div
						className="pointer-events-none absolute -top-20 -left-16 w-48 h-48 rounded-full opacity-[0.14] blur-2xl"
						style={{ background: "radial-gradient(circle,#9ce3f4,transparent 70%)" }}
					/>

					<div className="flex items-center gap-2 mb-6 relative z-1">
						<Logo className="w-6" />
						<span className="font-display text-[16px]">Parmelia</span>
					</div>

					{/* Status icon: check (confirmed) / spinner (in flight) / cross (failed) */}
					{confirmed && (
						<div className="w-16 h-16 rounded-full bg-sky/15 flex items-center justify-center mb-6 shadow-glow-sky-soft relative z-1">
							<IconCheck />
						</div>
					)}
					{pending && (
						<div className="w-16 h-16 rounded-full bg-sky/15 flex items-center justify-center mb-6 relative z-1">
							<Spinner className="w-7 h-7" />
						</div>
					)}
					{failed && (
						<div className="w-16 h-16 rounded-full bg-pink/15 flex items-center justify-center mb-6 relative z-1">
							<IconCross />
						</div>
					)}

					<p className="text-[15px] text-text-muted mb-1 relative z-1">
						{confirmed
							? t("paymentStatus.paidLead")
							: failed
								? t("paymentStatus.failedLead")
								: t("paymentStatus.pendingLead")}
					</p>
					{amount && (
						<p className="font-display text-[44px] leading-tight mb-4 tabular relative z-1 max-w-full break-words text-center">
							{formatAmount(amount, currency ?? "")}
							<span className="text-text-muted text-[22px] ml-1.5">{currency}</span>
						</p>
					)}

					{toLabel && (
						<p className="text-text-faint text-[13px] mb-1 relative z-1">
							{t("paymentStatus.to")} <span className="text-text-muted">{toLabel}</span>
						</p>
					)}
					{confirmed && (
						<p className="text-[12px] text-text-faint relative z-1">
							{t("paymentStatus.securedOn", { network: activeNetwork.name })}
						</p>
					)}
					{pending && (
						<p role="status" aria-live="polite" className="text-[12px] text-text-faint text-center leading-relaxed relative z-1 animate-pulse-soft">
							{poll.ended ? t("paymentStatus.pendingSlow") : t("paymentStatus.pendingBody")}
						</p>
					)}
					{failed && (
						<p role="status" aria-live="polite" className="text-[12px] text-text-faint text-center leading-relaxed relative z-1">
							{t("paymentStatus.failedBody")}
						</p>
					)}

					{/* Formal receipt info */}
					<div className="w-full border-t border-border mt-5 pt-4 relative z-1 flex flex-col gap-1.5">
						<div className="flex items-center justify-between text-[12px]">
							<span className="text-text-faint">{t("common.date")}</span>
							<span className="text-text-muted">{formatDate(new Date())}</span>
						</div>
						<div className="flex items-center justify-between text-[12px]">
							<span className="text-text-faint">{t("common.time")}</span>
							<span className="text-text-muted">{formatTime(new Date())}</span>
						</div>
						{txHash && (
							<div className="flex items-center justify-between text-[12px] gap-3">
								<span className="text-text-faint shrink-0">{t("receipt.receiptNo")}</span>
								<span className="text-text-muted font-mono truncate">
									{txHash.slice(0, 10)}…{txHash.slice(-8)}
								</span>
							</div>
						)}
						<p className="text-[11px] text-text-faint text-center mt-2">parmelia.me</p>
					</div>

					{txHash && (
						<a
							href={getExplorerTxUrl(txHash)}
							target="_blank"
							rel="noopener noreferrer"
							className="text-text-faint text-[12px] mt-3 relative z-1"
						>
							{t("paymentStatus.viewOnNetwork")}
						</a>
					)}
				</div>
			</div>

			{/* Share/download only make sense for a settled receipt. */}
			{confirmed ? (
				<div className="flex gap-3 mt-6">
					<button onClick={handleShare} className="btn btn-primary flex-1">
						{t("paymentStatus.share")}
					</button>
					<button onClick={handleDownload} className="btn btn-ghost">
						{t("paymentStatus.download")}
					</button>
				</div>
			) : (
				<button onClick={() => navigate("/")} className="btn btn-primary btn-block mt-6">
					{t("pay.goHome")}
				</button>
			)}
		</Screen>
	);
}

import { useState, useRef } from "react";
import useSWR from "swr";
import { QRCodeSVG } from "qrcode.react";
import type { User } from "../lib/firebase";
import Logo from "../components/Logo";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import AmountInput from "../components/AmountInput";
import TxResult from "../components/TxResult";
import { RowSkeletonList } from "../components/Skeleton";
import { apiFetch } from "../lib/api";
import { notifyError, notifySuccess } from "../lib/notify";
import { track } from "../lib/analytics";
import { activeNetwork, getExplorerTxUrl } from "../lib/activeNetwork";
import { useTranslation } from "react-i18next";
import { downloadCard, shareCard } from "../lib/exportCard";
import { formatAmount, formatDate, formatDateTime } from "../lib/format";

const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.me";

// GET /links shape (server PaymentLinkRecord, owner-scoped, latest 20).
type ChargeLink = {
	id: string;
	amount: string;
	currency: string;
	reference: string;
	status: "pending" | "paid";
	txHash: string | null;
	paidAt: string | null;
	createdAt: string;
};

export default function CreateLink({ user }: { user: User }) {
	const { t } = useTranslation();
	const [step, setStep] = useState<"form" | "result" | "detail">("form");
	const [amount, setAmount] = useState("");
	const [currency, setCurrency] = useState("USDC");
	const [reference, setReference] = useState("");
	const [loading, setLoading] = useState(false);
	const [paymentUrl, setPaymentUrl] = useState("");
	const [detailLink, setDetailLink] = useState<ChargeLink | null>(null);
	const cardRef = useRef<HTMLDivElement>(null);

	// "Tus cobros": the link stops being fire-and-forget - pending ones reopen
	// with their QR, paid ones show the receipt. Fetched only while on the form.
	const { data: linksData, isLoading: linksLoading, mutate: mutateLinks } = useSWR(
		step === "form" ? "/links" : null,
		(path: string) => apiFetch<{ links: ChargeLink[] }>(path, { user }),
	);
	const charges = linksData?.links ?? [];
	// Bounded on both ends: 5 visible by default, "Ver todos" expands to the
	// server's cap (latest 20). Full history with pagination is a later page.
	const [showAllCharges, setShowAllCharges] = useState(false);
	const visibleCharges = showAllCharges ? charges : charges.slice(0, 5);

	function openCharge(link: ChargeLink) {
		if (link.status === "paid") {
			setDetailLink(link);
			setStep("detail");
			return;
		}
		// Reopen the pending link exactly as when it was created.
		setPaymentUrl(`${APP_URL}/pay?id=${link.id}`);
		setAmount(Number(link.amount) > 0 ? link.amount : "");
		setCurrency(link.currency);
		setReference(link.reference || "");
		setStep("result");
	}

	async function handleCreate() {
		setLoading(true);
		try {
			const data = await apiFetch<{ id: string }>("/links", {
				user,
				body: { amount, currency, reference },
			});
			setPaymentUrl(`${APP_URL}/pay?id=${data.id}`);
			track("link_created", { currency, openAmount: Number(amount) <= 0 });
			void mutateLinks();
			setStep("result");
		} catch (err) {
			notifyError(err, t("createLink.createError"));
		} finally {
			setLoading(false);
		}
	}

	// Compartir = imagen del QR (sobre fondo blanco) + el link de pago.
	async function handleShare() {
		const shared = await shareCard(cardRef.current, {
			filename: "parmelia-cobro.png",
			text: t("createLink.shareText", { url: paymentUrl }),
			url: paymentUrl,
		});
		if (!shared) {
			navigator.clipboard.writeText(paymentUrl);
			notifySuccess(t("createLink.linkCopied"));
		}
	}

	// Descargar = solo la imagen del QR.
	async function handleDownload() {
		try {
			await downloadCard(cardRef.current, `parmelia-cobro-${amount || "abierto"}-${currency}.png`);
		} catch (err) {
			notifyError(err, t("createLink.downloadError"));
		}
	}

	// Copiar = solo el link. Ofrecemos Compartir como accion directa en el toast.
	function handleCopy() {
		navigator.clipboard.writeText(paymentUrl);
		notifySuccess(t("createLink.linkCopied"), undefined, {
			title: t("common.share"),
			onClick: () => void handleShare(),
		});
	}

	if (step === "detail" && detailLink) {
		return (
			<Screen>
				<BackHeader onClick={() => setStep("form")} title={t("createLink.detailTitle")} className="mb-6" />
				<TxResult
					state="success"
					lead={t("createLink.detailPaidLead")}
					amount={
						Number(detailLink.amount) > 0
							? formatAmount(detailLink.amount, detailLink.currency)
							: t("createLink.openAmount")
					}
					unit={Number(detailLink.amount) > 0 ? detailLink.currency : undefined}
					body={detailLink.paidAt ? formatDateTime(detailLink.paidAt) : undefined}
				>
					{detailLink.reference && (
						<p className="text-[13px] text-text-muted leading-relaxed max-w-[300px] mt-1">
							{detailLink.reference}
						</p>
					)}
					{detailLink.txHash && (
						<a
							href={getExplorerTxUrl(detailLink.txHash)}
							target="_blank"
							rel="noopener noreferrer"
							className="btn-text mt-5"
						>
							{t("settings.viewExplorer")}
						</a>
					)}
				</TxResult>
			</Screen>
		);
	}

	if (step === "result") {
		return (
			<Screen>
				<BackHeader onClick={() => setStep("form")} title={t("createLink.resultTitle")} className="mb-6" />

				<div className="flex-1 flex flex-col justify-center">
					<div
						ref={cardRef}
						className="relative overflow-hidden bg-surface border border-border rounded-[24px] p-7 flex flex-col items-center shadow-e2"
					>
						<div
							className="absolute top-0 left-0 right-0 h-1"
							style={{ background: "linear-gradient(100deg,#9ce3f4,#f4a9cf 52%,#efe08c)" }}
						/>
						<div
							className="pointer-events-none absolute -top-20 -right-16 w-48 h-48 rounded-full opacity-[0.14] blur-2xl"
							style={{ background: "radial-gradient(circle,#9ce3f4,transparent 70%)" }}
						/>

						<div className="flex items-center gap-2 mb-6 relative z-1">
							<Logo className="w-6" />
							<span className="font-display text-[16px]">Parmelia</span>
						</div>

						<div className="bg-white rounded-[18px] p-5 mb-6 shadow-e2 relative z-1">
							<QRCodeSVG value={paymentUrl} size={216} bgColor="#ffffff" fgColor="#0A0A0B" level="M" />
						</div>

						{Number(amount) > 0 ? (
							<p className="font-display text-[34px] leading-none tabular mb-2 relative z-1">
								{amount}
								<span className="text-text-muted text-[18px] ml-1.5">{currency}</span>
							</p>
						) : (
							<p className="font-display text-[24px] text-glow-pink mb-2 relative z-1">{t("createLink.openAmount")}</p>
						)}

						{reference && (
							<p className="text-text-muted text-[14px] text-center leading-relaxed px-2 relative z-1">
								{reference}
							</p>
						)}
						<p className="text-[12px] text-text-faint mt-5 relative z-1">
							{t("createLink.securePayIn", { network: activeNetwork.name })}
						</p>
					</div>
				</div>

				<button onClick={handleShare} className="btn btn-primary btn-block mt-6">
					{t("createLink.share")}
				</button>
				<div className="flex gap-3 mt-3">
					<button onClick={handleDownload} className="btn btn-ghost flex-1">
						{t("createLink.downloadQr")}
					</button>
					<button onClick={handleCopy} className="btn btn-ghost flex-1">
						{t("createLink.copyLink")}
					</button>
				</div>
				{/* WhatsApp is where LATAM charges actually travel - one tap, no share sheet. */}
				<a
					href={`https://wa.me/?text=${encodeURIComponent(t("createLink.shareText", { url: paymentUrl }))}`}
					target="_blank"
					rel="noopener noreferrer"
					className="btn btn-ghost btn-block mt-3"
				>
					{t("createLink.whatsapp")}
				</a>
			</Screen>
		);
	}

	return (
		<Screen>
			<BackHeader to="/" title={t("createLink.title")} />

			{/* Amount - big input */}
			<div className="flex flex-col items-center mt-6 mb-8">
				<AmountInput
					name="amount"
					aria-label={t("createLink.amountLabel")}
					placeholder="0"
					value={amount}
					onChange={setAmount}
					className="w-full max-w-[260px] bg-transparent text-center font-display text-[60px] leading-none text-text placeholder:text-text-faint tabular"
				/>
				<div className="seg-track mt-4">
					{activeNetwork.currencies.map((c) => (
						<button
							key={c}
							onClick={() => setCurrency(c)}
							aria-pressed={currency === c}
							data-active={currency === c}
							className="seg-item"
						>
							{c}
						</button>
					))}
				</div>
				<p className="text-[12px] text-text-faint mt-4">
					{t("createLink.openAmountHint")}
				</p>
			</div>

			{/* Reference */}
			<div className="bg-surface border border-border rounded-[18px] p-5 mb-6 shadow-e1">
				<label htmlFor="create-link-reference" className="text-[13px] text-text-muted mb-2 block">
					{t("createLink.referenceLabel")}
				</label>
				<textarea
					id="create-link-reference"
					name="reference"
					placeholder={t("createLink.referencePlaceholder")}
					value={reference}
					onChange={(e) => setReference(e.target.value)}
					maxLength={200}
					rows={2}
					className="w-full bg-bg border border-border rounded-[12px] px-3.5 py-3 text-[14px] text-text placeholder:text-text-faint resize-none focus:border-border-strong transition-colors"
				/>
			</div>

			<button onClick={handleCreate} disabled={loading} className="btn btn-primary btn-block">
				{loading ? t("createLink.creating") : t("createLink.create")}
			</button>

			{/* Tus cobros: pending reopens the QR view, paid opens the receipt. */}
			{(linksLoading || charges.length > 0) && (
				<div className="mt-9">
					<h2 className="text-[15px] font-display mb-3">{t("createLink.myCharges")}</h2>
					{linksLoading ? (
						<RowSkeletonList count={3} />
					) : (
						<div className="bg-surface border border-border rounded-[18px] shadow-e1 divide-y divide-border overflow-hidden">
							{visibleCharges.map((link) => (
								<button
									key={link.id}
									onClick={() => openCharge(link)}
									className="w-full flex items-center justify-between gap-3 px-4 py-3.5 text-left hover:bg-surface-2 transition-colors"
								>
									<div className="min-w-0">
										<p className="text-[14px] truncate">
											{Number(link.amount) > 0
												? `${formatAmount(link.amount, link.currency)} ${link.currency}`
												: t("createLink.openAmount")}
										</p>
										<p className="text-[12px] text-text-faint truncate">
											{formatDate(link.createdAt, { day: "numeric", month: "short" })}
											{link.reference ? ` · ${link.reference}` : ""}
										</p>
									</div>
									<span
										className={`text-[11px] rounded-full px-2.5 py-1 shrink-0 ${
											link.status === "paid"
												? "bg-sky/15 text-glow-sky"
												: "bg-surface-2 text-text-muted"
										}`}
									>
										{link.status === "paid"
											? t("createLink.statusPaid")
											: t("createLink.statusPending")}
									</span>
								</button>
							))}
						</div>
					)}
					{!linksLoading && charges.length > 5 && (
						<button
							onClick={() => setShowAllCharges((v) => !v)}
							className="btn-text mx-auto mt-3"
						>
							{showAllCharges
								? t("createLink.viewLess")
								: t("createLink.viewAll", { count: charges.length })}
						</button>
					)}
				</div>
			)}
		</Screen>
	);
}

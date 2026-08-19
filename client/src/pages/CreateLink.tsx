import { useState, useRef } from "react";
import useSWR from "swr";
import { QRCodeSVG } from "qrcode.react";
import type { User } from "../lib/firebase";
import Logo from "../components/Logo";
import MeliSprite from "../components/brand/MeliSprite";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import AmountInput from "../components/AmountInput";
import TxResult from "../components/TxResult";
import { RowSkeletonList } from "../components/Skeleton";
import TokenSelect from "../components/TokenSelect";
import { apiFetch } from "../lib/api";
import { notifyError, notifySuccess } from "../lib/notify";
import { track } from "../lib/analytics";
import { activeNetwork, getExplorerTxUrl } from "../lib/activeNetwork";
import { useTranslation } from "react-i18next";
import { downloadCard, shareCard } from "../lib/exportCard";
import { formatAmount, formatDate, formatDateTime } from "../lib/format";
import { APP_URL } from "../lib/brand";
import {
	MoneyPanel,
	PanelActions,
	SectionLabel,
	TransactionActions,
} from "../components/finance/FinancialPrimitives";

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

	// Compartir = tarjeta Meli del QR + link de pago.
	async function handleShare() {
		const shared = await shareCard(cardRef.current, {
			filename: "gatopago-cobro.png",
			text: t("createLink.shareText", { url: paymentUrl }),
			url: paymentUrl,
		});
		if (!shared) {
			navigator.clipboard.writeText(paymentUrl);
			notifySuccess(t("createLink.linkCopied"));
		}
	}

	// Descargar = tarjeta Meli completa, lista para enviar o imprimir.
	async function handleDownload() {
		try {
			await downloadCard(cardRef.current, `gatopago-cobro-${amount || "abierto"}-${currency}.png`);
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
					<MoneyPanel
						ref={cardRef}
						className="relative flex flex-col items-center overflow-hidden p-7"
					>
						<div className="receipt-rail absolute inset-x-0 top-0 h-1" />
						<MeliSprite name="head-peek" className="pointer-events-none absolute right-3 top-2 w-12 opacity-80" />

						<div className="flex items-center gap-2 mb-6 relative z-1">
							<Logo className="w-6" />
							<span className="font-display text-[16px]">GatoPago</span>
						</div>

						<div className="relative z-1 mb-6 border-2 border-text bg-white p-5 shadow-[6px_6px_0_var(--color-cat-700)]">
							<QRCodeSVG value={paymentUrl} size={216} bgColor="#ffffff" fgColor="#0A0A0B" level="M" />
						</div>

						{Number(amount) > 0 ? (
							<p className="type-mono relative z-1 mb-2 text-[34px] font-bold leading-none">
								{amount}
								<span className="text-text-muted text-[18px] ml-1.5">{currency}</span>
							</p>
						) : (
							<p className="relative z-1 mb-2 font-display text-[24px] text-cat-300">{t("createLink.openAmount")}</p>
						)}

						{reference && (
							<p className="text-text-muted text-[14px] text-center leading-relaxed px-2 relative z-1">
								{reference}
							</p>
						)}
						<p className="text-[12px] text-text-faint mt-5 relative z-1">
							{t("createLink.securePayIn", { network: activeNetwork.name })}
						</p>
					</MoneyPanel>
				</div>

				<TransactionActions>
					<button onClick={handleShare} className="btn btn-primary btn-block">
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
				</TransactionActions>
			</Screen>
		);
	}

	return (
		<Screen>
			<BackHeader title={t("createLink.title")} />

			{/* Amount */}
			<MoneyPanel className="flex flex-col items-center mb-5">
				<p className="text-[13px] text-text-muted mb-4">{t("createLink.amountLabel")}</p>
				<AmountInput
					name="amount"
					aria-label={t("createLink.amountLabel")}
					placeholder="0"
					value={amount}
					onChange={setAmount}
					className="w-full max-w-[260px] bg-transparent text-center font-display text-[48px] leading-none text-text placeholder:text-text-faint tabular"
				/>
				<TokenSelect value={currency} options={activeNetwork.currencies} onChange={setCurrency} className="mt-4" />
				<p className="text-[12px] text-text-faint mt-4">
					{t("createLink.openAmountHint")}
				</p>
			</MoneyPanel>

			{/* Reference */}
			<MoneyPanel className="mb-5">
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
					className="meli-field h-auto w-full resize-none py-3 text-[14px] placeholder:text-text-faint"
				/>
			</MoneyPanel>

			<PanelActions>
				<button onClick={handleCreate} disabled={loading} className="btn btn-primary btn-block">
					{loading ? t("createLink.creating") : t("createLink.create")}
				</button>
			</PanelActions>

			{/* Tus cobros: pending reopens the QR view, paid opens the receipt. */}
			{(linksLoading || charges.length > 0) && (
				<div className="mt-9">
					<SectionLabel>{t("createLink.myCharges")}</SectionLabel>
					{linksLoading ? (
						<RowSkeletonList count={3} />
					) : (
						<div className="meli-paper-card meli-paper-card--strong divide-y divide-border overflow-hidden">
							{visibleCharges.map((link) => (
								<button
									key={link.id}
									onClick={() => openCharge(link)}
									className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
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
									className={`meli-chip shrink-0 ${
											link.status === "paid"
										? "bg-growth/15 text-growth"
										: "bg-pending/10 text-pending"
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

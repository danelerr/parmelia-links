import { useEffect, useState } from "react";
import { useSearchParams, useParams } from "react-router-dom";
import { ApiError, SERVER_URL, apiFetch } from "../lib/api";
import { isUserCancelled, notifyError, notifyWarning } from "../lib/notify";
import { track } from "../lib/analytics";
import { signInWithGoogle, type User } from "../lib/firebase";
import Logo from "../components/Logo";
import { signWithPasskey } from "../lib/webauthn";
import { activeNetwork } from "../lib/activeNetwork";
import { hexToBytes } from "../lib/hex";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { useTranslation } from "react-i18next";
import { formatAmount } from "../lib/format";

const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.me";
const APP_HOST = new URL(APP_URL).hostname;

type PayStage = "idle" | "preparing" | "signing" | "securing";

interface LinkData {
	id: string;
	amount: string;
	currency: string;
	reference: string;
	wallet: string;
	status: "pending" | "paid";
	username?: string;
}

interface UserProfile {
	username: string;
	walletAddress: string;
}

// A pending manual payment awaiting explicit confirmation (free-typed,
// irreversible destinations get a review step before the biometric signature).
type ManualConfirm = {
	wallet: string;
	amount: string;
	currency: string;
	isAddress: boolean;
	username?: string;
};

function BackButton({ onClick }: { onClick: () => void }) {
	const { t } = useTranslation();
	return (
		<button
			onClick={onClick}
			aria-label={t("common.back")}
			className="w-10 h-10 -ml-1 rounded-full flex items-center justify-center text-text-muted hover:text-text hover:bg-surface transition-colors"
		>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
				<path d="M19 12H5" />
				<path d="M12 19l-7-7 7-7" />
			</svg>
		</button>
	);
}

/** Anti-phishing trust seal - always visible when paying. */
function TrustBadge() {
	const { t } = useTranslation();
	return (
		<div className="flex items-center justify-center gap-2 mb-7">
			<Logo className="w-6" />
			<span className="text-[13px] text-text-muted">
				{t("pay.secureWith")} <span className="text-text font-medium">Parmelia</span>
			</span>
		</div>
	);
}

function Recipient({ label }: { label: string }) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col items-center gap-2 mb-6">
			<div className="w-12 h-12 rounded-full bg-pink/15 flex items-center justify-center font-display text-[18px] text-glow-pink uppercase">
				{label.replace(/^@/, "")[0] || "?"}
			</div>
			<p className="text-[14px] text-text-muted">
				{t("pay.payingTo")} <span className="text-text font-medium">{label}</span>
			</p>
		</div>
	);
}

function PayingOverlay({ stage }: { stage: PayStage }) {
	const { t } = useTranslation();
	const copy: Record<Exclude<PayStage, "idle">, string> = {
		preparing: t("pay.stagePreparing"),
		signing: t("pay.stageSigning"),
		securing: t("pay.stageSecuring"),
	};
	if (stage === "idle") return null;
	return (
		<div className="fixed inset-0 z-50 bg-bg/92 backdrop-blur-sm flex flex-col items-center justify-center gap-6 animate-fade-in">
			<Logo className="w-16 animate-float-glow glow-soft" />
			<div className="flex flex-col items-center gap-3">
				{stage !== "signing" && (
					<div className="w-6 h-6 border-2 border-surface-2 border-t-sky rounded-full animate-spin" />
				)}
				<p className="text-[16px] text-text font-display">{copy[stage]}</p>
			</div>
		</div>
	);
}

/** Confirmation sheet shown before signing a manual (free-typed) payment.
 *  Surfaces the full destination so the user can verify an irreversible send. */
function ManualConfirmSheet({
	tx,
	onConfirm,
	onCancel,
}: {
	tx: ManualConfirm | null;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation();
	if (!tx) return null;
	return (
		<div
			className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end justify-center px-5 animate-fade-in"
			style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
			onClick={onCancel}
		>
			<div
				className="w-full max-w-sm bg-surface border border-border rounded-[24px] p-6 shadow-e3 animate-fade-up"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-center gap-2 mb-5">
					<Logo className="w-6" />
					<span className="text-[13px] text-text-muted">{t("pay.confirmTitle")}</span>
				</div>
				<p className="text-[13px] text-text-muted text-center mb-1">{t("pay.youWillSend")}</p>
				<p className="font-display text-[40px] leading-tight tabular text-center mb-5 max-w-full break-words">
					{formatAmount(tx.amount, tx.currency)}
					<span className="text-text-muted text-[20px] ml-1.5">{tx.currency}</span>
				</p>
				<div className="bg-bg border border-border rounded-[14px] px-4 py-3 mb-3">
					<span className="text-[12px] text-text-muted block mb-1">{t("pay.to")}</span>
					{tx.isAddress ? (
						<span className="text-[13px] text-text font-mono break-all">{tx.wallet}</span>
					) : (
						<span className="text-[15px] text-text">@{tx.username}</span>
					)}
				</div>
				<p className="text-[12px] text-text-faint text-center mb-5 leading-relaxed">
					{t("pay.confirmWarning")}
				</p>
				<button onClick={onConfirm} className="btn btn-gradient btn-block">
					{t("pay.confirmAndPay")}
				</button>
				<button onClick={onCancel} className="btn-text w-full mt-1">
					{t("pay.cancel")}
				</button>
			</div>
		</div>
	);
}

export default function PayPage({ user }: { user: User | null }) {
	const [searchParams] = useSearchParams();
	const { username } = useParams();
	const navigate = useViewTransitionNavigate();
	const { t } = useTranslation();
	const [linkData, setLinkData] = useState<LinkData | null>(null);
	const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
	const [loading, setLoading] = useState(true);
	const [paying, setPaying] = useState(false);
	const [payStage, setPayStage] = useState<PayStage>("idle");
	const [error, setError] = useState("");
	const [payAmount, setPayAmount] = useState("");
	const [payCurrency, setPayCurrency] = useState("USDC");
	const [showPayForm, setShowPayForm] = useState(false);
	const [manualMode, setManualMode] = useState(false);
	const [manualWallet, setManualWallet] = useState("");
	const [slowConnection, setSlowConnection] = useState(false);
	const [destType, setDestType] = useState<"address" | "username">("username");
	const [resolvingUsername, setResolvingUsername] = useState(false);
	const [confirmTx, setConfirmTx] = useState<ManualConfirm | null>(null);

	const linkId = searchParams.get("id");
	const amountParam = searchParams.get("amount");
	const currencyParam = searchParams.get("currency") || "USDC";
	const refParam = searchParams.get("ref");
	const walletParam = searchParams.get("wallet");

	useEffect(() => {
		const slowTimer = setTimeout(() => setSlowConnection(true), 5000);

		async function fetchLink(id: string) {
			try {
				const res = await fetch(`${SERVER_URL}/links/${id}`);
				if (!res.ok) throw new Error("Link no encontrado");
				setLinkData(await res.json());
			} catch {
				setError(t("pay.linkNotFound"));
			} finally {
				setLoading(false);
			}
		}

		async function fetchByUsername(uname: string) {
			try {
				const res = await fetch(`${SERVER_URL}/user/${uname}`);
				if (!res.ok) throw new Error("Usuario no encontrado");
				const data = await res.json();
				setUserProfile(data);
				setLinkData({
					id: "username",
					amount: amountParam || "",
					currency: currencyParam,
					reference: refParam || "",
					wallet: data.walletAddress,
					status: "pending",
					username: uname,
				});
			} catch {
				setError(t("pay.userNotFound"));
			} finally {
				setLoading(false);
			}
		}

		if (linkId) {
			fetchLink(linkId);
		} else if (username) {
			fetchByUsername(username);
		} else if (amountParam) {
			setLinkData({
				id: "direct",
				amount: amountParam,
				currency: currencyParam,
				reference: refParam || "",
				wallet: walletParam || "",
				status: "pending",
			});
			setLoading(false);
		} else {
			setManualMode(true);
			setLoading(false);
		}

		return () => clearTimeout(slowTimer);
		// Depend on the parsed primitives only - searchParams is a fresh object
		// each render and would re-run this fetch effect unnecessarily.
	}, [linkId, username, amountParam, currencyParam, refParam, walletParam]);

	/** Two-step pay: prepare → biometric sign → submit, with human micro-states. */
	async function executePay(params: { linkId: string; wallet: string; amount: string; currency: string }) {
		if (!user) return;
		setPaying(true);
		setError("");
		setPayStage("preparing");
		const paySlowTimer = setTimeout(() => setSlowConnection(true), 6000);
		try {
			const { userOpHash, credentialId } = await apiFetch<{
				userOpHash: string;
				credentialId: string | null;
			}>("/pay/prepare", { user, body: params });

			setPayStage("signing");
			const challengeBytes = hexToBytes(userOpHash);
			const assertion = await signWithPasskey(challengeBytes, credentialId);

			setPayStage("securing");
			const { txHash } = await apiFetch<{ txHash: string }>("/pay/submit", {
				user,
				body: {
					userOpHash,
					authenticatorData: assertion.authenticatorData,
					clientDataJSON: assertion.clientDataJSON,
					r: assertion.r,
					s: assertion.s,
					credentialId: assertion.credentialId,
					qx: assertion.qx,
					qy: assertion.qy,
				},
			});
			const to = params.linkId === "username" ? linkData?.username || params.wallet : params.wallet;
			track("payment_sent", { currency: params.currency, via: params.linkId });
			navigate(`/pay/status?tx=${txHash}&amount=${params.amount}&currency=${params.currency}&to=${to}`);
		} catch (err) {
			if (isUserCancelled(err)) {
				// The user dismissed the passkey prompt - calm notice, no red.
				notifyWarning(t("notify.cancelled"), t("pay.paymentNotMade"));
				setError("");
			} else {
				// Prefer the server's stable error_code (language-independent); fall
				// back to the message-text heuristics for codeless/SDK errors.
				const code = err instanceof ApiError ? err.code : undefined;
				const msg = code
					? t(`err.${code}`, { defaultValue: err instanceof Error ? err.message : t("pay.processError") })
					: parsePaymentError(err instanceof Error ? err.message : t("pay.processError"));
				notifyError(
					new ApiError(msg, {
						status: 400,
						requestId: err instanceof ApiError ? err.requestId : undefined,
					}),
					t("pay.payError"),
				);
				setError(msg);
			}
		} finally {
			clearTimeout(paySlowTimer);
			setSlowConnection(false);
			setPaying(false);
			setPayStage("idle");
		}
	}

	// Map known raw errors (ERC-4337 codes, SDK strings, and the server's own
	// Spanish balance messages) to a message in the user's language — so backend
	// text never leaks untranslated. Truly unknown messages fall through.
	function parsePaymentError(msg: string): string {
		if (msg.includes("AA24")) return t("pay.errPasskeyValidate");
		if (msg.includes("AA21")) return t("pay.errInsufficient");
		if (msg.includes("AA25")) return t("pay.errSignatureInvalid");
		if (msg.includes("Missing qx/qy")) {
			return t("pay.errPasskeyDevice");
		}
		if (
			msg.includes("Saldo USDC insuficiente") ||
			msg.includes(`Saldo ${activeNetwork.nativeTokenSymbol} insuficiente`) ||
			msg.includes("Saldo ETH insuficiente") ||
			msg.includes("insufficient") ||
			msg.includes("Insufficient")
		)
			return t("pay.errInsufficient");
		if (msg.includes("Passkey not found") || msg.includes("Passkey no encontrada")) {
			return t("pay.errPasskeyNotFound");
		}
		if (msg.includes("No passkeys available")) {
			return t("pay.errNoPasskeys", { host: APP_HOST });
		}
		if (msg.includes("NotAllowedError") || msg.includes("timed out or was not allowed") || msg.includes("Firma cancelada")) {
			return t("pay.errCancelled");
		}
		if (msg.includes("FailedOp")) {
			const match = msg.match(/FailedOp\([^,]+,\s*"?([^")]+)/);
			if (match) return `Error: ${match[1]}`;
		}
		if (msg.length > 150) return t("pay.errGeneric");
		return msg;
	}

	async function handlePay() {
		if (!linkData || !user) return;
		const isStoredLink = !["direct", "username", "manual"].includes(linkData.id);
		const hasFixedAmount = Number(linkData.amount) > 0;
		const amount = hasFixedAmount ? linkData.amount : payAmount;
		const currency = isStoredLink || hasFixedAmount ? linkData.currency : payCurrency;
		if (!amount || Number(amount) <= 0) {
			notifyWarning(t("pay.invalidAmount"), t("pay.amountMustBePositive"));
			return;
		}
		await executePay({ linkId: linkData.id, wallet: linkData.wallet, amount, currency });
	}

	async function handleManualPay() {
		if (!user || !payAmount) return;
		let targetWallet = manualWallet;

		if (destType === "username") {
			if (!manualWallet.trim()) {
				notifyWarning(t("pay.enterUsername"));
				return;
			}
			setResolvingUsername(true);
			try {
				const res = await fetch(`${SERVER_URL}/user/${manualWallet.trim().toLowerCase()}`);
				if (!res.ok) throw new Error();
				const data = await res.json();
				if (!data.walletAddress) throw new Error();
				targetWallet = data.walletAddress;
			} catch {
				notifyWarning(t("pay.userNotFoundTitle"), t("pay.checkName"));
				setResolvingUsername(false);
				return;
			} finally {
				setResolvingUsername(false);
			}
		} else if (!/^0x[a-fA-F0-9]{40}$/.test(manualWallet)) {
			notifyWarning(t("pay.invalidAddress"), t("pay.mustBe0x"));
			return;
		}

		// Don't sign yet - review the resolved destination first (irreversible).
		setConfirmTx({
			wallet: targetWallet,
			amount: payAmount,
			currency: payCurrency,
			isAddress: destType === "address",
			username: destType === "username" ? manualWallet.trim().toLowerCase() : undefined,
		});
	}

	async function confirmAndPay() {
		if (!confirmTx) return;
		const tx = confirmTx;
		setConfirmTx(null);
		await executePay({ linkId: "manual", wallet: tx.wallet, amount: tx.amount, currency: tx.currency });
	}

	async function handleLogin() {
		try {
			const credential = await signInWithGoogle();
			if (credential) await credential.user.getIdToken(true);
		} catch {
			notifyError(new Error(t("pay.signInError")));
		}
	}

	const screen = "flex flex-col min-h-dvh px-5 pt-[calc(env(safe-area-inset-top)_+_1.5rem)] pb-[calc(env(safe-area-inset-bottom)_+_2.5rem)] w-full max-w-[460px] mx-auto";
	const bigInput =
		"w-full max-w-[260px] bg-transparent text-center font-display text-[56px] leading-none text-text placeholder:text-text-faint tabular";

	if (loading) {
		return (
			<div className="flex flex-col items-center justify-center min-h-dvh px-6 gap-4">
				<Logo className="w-16 animate-float-glow" />
				{slowConnection && <p className="text-text-muted text-[14px] animate-fade-in">{t("pay.slowConnection")}</p>}
			</div>
		);
	}

	if (error && !linkData) {
		return (
			<div className="flex flex-col items-center justify-center min-h-dvh gap-5 px-8 text-center">
				<Logo className="w-14 opacity-50" />
				<p className="text-text text-[16px] max-w-[280px]">{error}</p>
				<button onClick={() => navigate("/")} className="btn btn-primary btn-sm">
					{t("pay.goHome")}
				</button>
			</div>
		);
	}

	// Manual pay (open the app with no link)
	if (!linkData && manualMode) {
		// Amount must be a positive number. We surface a gentle hint only once the
		// user has typed a destination AND a non-positive amount (e.g. 0) — never
		// on an empty field, so it doesn't nag before they've started.
		const manualAmountNum = Number(payAmount);
		const manualAmountInvalid = !payAmount || !Number.isFinite(manualAmountNum) || manualAmountNum <= 0;
		const showAmountHint = !!manualWallet.trim() && payAmount.trim() !== "" && manualAmountInvalid;
		return (
			<div className={screen}>
				<PayingOverlay stage={payStage} />
				<ManualConfirmSheet
					tx={confirmTx}
					onConfirm={confirmAndPay}
					onCancel={() => setConfirmTx(null)}
				/>
				<header className="flex items-center gap-3 mb-6">
					<BackButton onClick={() => navigate("/")} />
					<h1 className="text-[22px]">{t("pay.payOrSend")}</h1>
				</header>

				<TrustBadge />

				<div className="flex flex-col items-center mb-6">
					<input
						type="number"
						placeholder="0"
						value={payAmount}
						onChange={(e) => setPayAmount(e.target.value)}
						step="any"
						min="0"
						inputMode="decimal"
						autoFocus
						className={bigInput}
					/>
					<div className="seg-track mt-4">
						{activeNetwork.currencies.map((c) => (
							<button key={c} onClick={() => setPayCurrency(c)} data-active={payCurrency === c} className="seg-item">
								{c}
							</button>
						))}
					</div>
				</div>

				<div className="bg-surface border border-border rounded-[18px] p-5 mb-5 shadow-e1">
					<div className="seg-track seg-track-block mb-4">
						{(["username", "address"] as const).map((dt) => (
							<button
								key={dt}
								onClick={() => {
									setDestType(dt);
									setManualWallet("");
								}}
								data-active={destType === dt}
								className="seg-item"
							>
								{dt === "address" ? t("pay.wallet") : t("pay.user")}
							</button>
						))}
					</div>
					<input
						type="text"
						placeholder={destType === "address" ? "0x…" : "tunombre"}
						value={manualWallet}
						onChange={(e) =>
							setManualWallet(
								destType === "username" ? e.target.value.replace(/[^a-z0-9_-]/gi, "").toLowerCase() : e.target.value.trim(),
							)
						}
						className={`w-full bg-bg border border-border rounded-[12px] px-3.5 h-12 text-[14px] text-text placeholder:text-text-faint focus:border-border-strong transition-colors ${destType === "address" ? "font-mono" : ""}`}
					/>
				</div>

				{error && <p className="text-glow-pink text-[13px] text-center mb-4">{error}</p>}

				{!user ? (
					<button onClick={handleLogin} className="btn btn-primary btn-block">
						{t("pay.signInToPay")}
					</button>
				) : (
					<button
						onClick={handleManualPay}
						disabled={paying || resolvingUsername || !manualWallet || manualAmountInvalid}
						className="btn btn-gradient btn-block"
					>
						{resolvingUsername ? t("pay.searchingUser") : t("common.pay")}
					</button>
				)}
				{showAmountHint && (
					<p className="text-text-faint text-[12px] text-center mt-3 animate-fade-in">
						{t("pay.amountMustBePositive")}
					</p>
				)}
			</div>
		);
	}

	if (!linkData) return null;

	const isStoredLink = !["direct", "username", "manual"].includes(linkData.id);
	const hasFixedAmount = Number(linkData.amount) > 0;
	const recipientLabel = linkData.username
		? `@${linkData.username}`
		: linkData.wallet
		? `${linkData.wallet.slice(0, 6)}…${linkData.wallet.slice(-4)}`
		: "esta cuenta";

	// Username profile page
	if (username && userProfile && !showPayForm) {
		return (
			<div className={screen}>
				<header className="flex items-center gap-3 mb-6">
					<BackButton onClick={() => navigate("/")} />
				</header>
				<div className="flex-1 flex flex-col items-center justify-center text-center animate-fade-up">
					<div className="w-20 h-20 rounded-full bg-pink/15 flex items-center justify-center font-display text-[32px] text-glow-pink uppercase mb-5">
						{userProfile.username[0]}
					</div>
					<h1 className="font-display text-[28px] mb-1">@{userProfile.username}</h1>
					<p className="text-[14px] text-text-muted">{t("pay.receivesPaymentsOn", { network: activeNetwork.name })}</p>
				</div>
				<button
					onClick={() => (user ? setShowPayForm(true) : handleLogin())}
					className="btn btn-primary btn-block"
				>
					{user ? t("pay.payTo", { name: userProfile.username }) : t("pay.signInToPay")}
				</button>
			</div>
		);
	}

	// Paid link
	if (linkData.status === "paid") {
		return (
			<div className={screen}>
				<header className="flex items-center gap-3 mb-6">
					<BackButton onClick={() => navigate("/")} />
				</header>
				<div className="flex-1 flex flex-col items-center justify-center text-center">
					<div className="w-16 h-16 rounded-full bg-sky/15 flex items-center justify-center mb-6 shadow-glow-sky">
						<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#9ce3f4" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
							<polyline points="20 6 9 17 4 12" />
						</svg>
					</div>
					<p className="text-[15px] text-text-muted mb-1">{t("pay.alreadyPaid")}</p>
					<p className="font-display text-[40px] tabular leading-tight max-w-full break-words text-center">
						{formatAmount(linkData.amount, linkData.currency)}
						<span className="text-text-muted text-[20px] ml-1.5">{linkData.currency}</span>
					</p>
					{linkData.reference && <p className="text-text-muted text-[14px] mt-3">{linkData.reference}</p>}
				</div>
			</div>
		);
	}

	// Payment form (fixed link, open link, or username transfer)
	const isOpenAmount = !hasFixedAmount;

	return (
		<div className={screen}>
			<PayingOverlay stage={payStage} />
			<header className="flex items-center gap-3 mb-6">
				<BackButton onClick={() => (showPayForm ? setShowPayForm(false) : navigate("/"))} />
			</header>

			<TrustBadge />
			<Recipient label={recipientLabel} />

			{/* Amount */}
			<div className="flex flex-col items-center mb-6">
				{hasFixedAmount ? (
					<p className="font-display text-[56px] leading-tight tabular max-w-full break-words text-center">
						{formatAmount(linkData.amount, linkData.currency)}
						<span className="text-text-muted text-[24px] ml-2">{linkData.currency}</span>
					</p>
				) : (
					<>
						<input
							type="number"
							placeholder="0"
							value={payAmount}
							onChange={(e) => setPayAmount(e.target.value)}
							step="any"
							min="0"
							inputMode="decimal"
							autoFocus
							className={bigInput}
						/>
						<div className="seg-track mt-4">
							{activeNetwork.currencies.map((c) => {
								// Stored links fix the currency; only direct/username let you choose.
								const fixed = isStoredLink;
								const value = fixed ? linkData.currency : payCurrency;
								return (
									<button
										key={c}
										disabled={fixed && c !== linkData.currency}
										onClick={() => !fixed && setPayCurrency(c)}
										data-active={value === c}
										className={`seg-item ${fixed && c !== linkData.currency ? "opacity-30" : ""}`}
									>
										{c}
									</button>
								);
							})}
						</div>
						<p className="text-[12px] text-text-faint mt-3">{t("pay.chooseCurrency")}</p>
					</>
				)}
			</div>

			{linkData.reference && (
				<p className="text-text-muted text-[14px] text-center mb-6 px-4 leading-relaxed">
					{linkData.reference}
				</p>
			)}

			<p className="text-[12px] text-text-faint text-center mb-5">{t("common.noNetworkFees")}</p>

			{error && <p className="text-glow-pink text-[13px] text-center mb-4">{error}</p>}

			{!user ? (
				<button onClick={handleLogin} className="btn btn-primary btn-block">
					Inicia sesión para pagar
				</button>
			) : (
				<button
					onClick={handlePay}
					disabled={paying || (isOpenAmount && !payAmount)}
					className="btn btn-gradient btn-block"
				>
					Pagar
				</button>
			)}
			{slowConnection && paying && (
				<p className="text-text-faint text-[12px] text-center mt-3 animate-fade-in">
					{t("pay.networkSlow")}
				</p>
			)}
		</div>
	);
}

import { useEffect, useState } from "react";
import { useSearchParams, useParams } from "react-router-dom";
import { ApiError, SERVER_URL, apiFetch } from "../lib/api";
import { isUserCancelled, notifyError, notifyWarning } from "../lib/notify";
import { track } from "../lib/analytics";
import { signInWithGoogle, type User } from "../lib/firebase";
import Logo from "../components/Logo";
import { signWithPasskey } from "../lib/webauthn";
import { submitUserOp } from "../lib/submit";
import { activeNetwork } from "../lib/activeNetwork";
import { hexToBytes } from "../lib/hex";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { useTranslation } from "react-i18next";
import { formatAmount } from "../lib/format";
import { parseTransactions, formatShortDate, type Transaction } from "../lib/transactions";
import OptionCard from "../components/OptionCard";
import AmountInput from "../components/AmountInput";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import StageOverlay from "../components/StageOverlay";
import ConfirmSheet from "../components/ConfirmSheet";
import TxResult from "../components/TxResult";

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
	displayName?: string | null;
	socialUrl?: string | null;
}

/** "https://www.instagram.com/juan" -> "instagram.com/juan" for display. */
function socialLabel(url: string): string {
	return url.replace(/^https:\/\/(www\.)?/, "");
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

function Recipient({ label, name }: { label: string; name?: string | null }) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col items-center gap-2 mb-6">
			<div className="w-12 h-12 rounded-full bg-pink/15 flex items-center justify-center font-display text-[18px] text-glow-pink uppercase">
				{(name || label).replace(/^@/, "")[0] || "?"}
			</div>
			<h1 className="text-[14px] text-text-muted">
				{t("pay.payingTo")} <span className="text-text font-medium">{name || label}</span>
				{name && <span className="text-text-faint"> · {label}</span>}
			</h1>
		</div>
	);
}

/** Detail block inside the shared ConfirmSheet: the resolved destination of a
 *  manual (free-typed) payment, surfaced in full before the biometric prompt. */
function ConfirmDestination({ tx }: { tx: ManualConfirm }) {
	const { t } = useTranslation();
	return (
		<div className="bg-bg border border-border rounded-[14px] px-4 py-3 mb-3">
			<span className="text-[12px] text-text-muted block mb-1">{t("pay.to")}</span>
			{tx.isAddress ? (
				<span className="text-[13px] text-text font-mono break-all">{tx.wallet}</span>
			) : (
				<span className="text-[15px] text-text">@{tx.username}</span>
			)}
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
	// Saved contacts, surfaced as one-tap destinations in manual mode.
	const [contacts, setContacts] = useState<{ id: string; username: string; alias: string | null }[]>([]);
	// Own balance, visible at the moment of paying (top ask from field testing).
	const [balances, setBalances] = useState<Record<string, string>>({});
	// Payment history with this recipient (derived client-side from the ledger's
	// to/from wallets). Signed-in users on the username profile page only.
	const [payHistory, setPayHistory] = useState<{ count: number; last: Transaction | null } | null>(null);

	const stageCopy: Record<Exclude<PayStage, "idle">, string> = {
		preparing: t("pay.stagePreparing"),
		signing: t("pay.stageSigning"),
		securing: t("pay.stageSecuring"),
	};

	const linkId = searchParams.get("id");
	const amountParam = searchParams.get("amount");
	const currencyParam = searchParams.get("currency") || "USDC";
	const refParam = searchParams.get("ref");
	const walletParam = searchParams.get("wallet");

	useEffect(() => {
		// Slow-connection hint scoped to the INITIAL fetch only: armed when a
		// request actually starts and disarmed the moment it settles, so it can't
		// fire while the user idles on the form. The submit flow arms its own
		// timer inside executePay.
		let slowTimer: ReturnType<typeof setTimeout> | null = null;
		function armSlowHint() {
			slowTimer = setTimeout(() => setSlowConnection(true), 5000);
		}
		function disarmSlowHint() {
			if (slowTimer) clearTimeout(slowTimer);
			slowTimer = null;
			setSlowConnection(false);
		}

		async function fetchLink(id: string) {
			armSlowHint();
			try {
				const res = await fetch(`${SERVER_URL}/links/${id}`);
				if (!res.ok) throw new Error("Link no encontrado");
				setLinkData(await res.json());
			} catch {
				setError(t("pay.linkNotFound"));
			} finally {
				disarmSlowHint();
				setLoading(false);
			}
		}

		async function fetchByUsername(uname: string) {
			armSlowHint();
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
				disarmSlowHint();
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

		return () => {
			if (slowTimer) clearTimeout(slowTimer);
		};
		// Depend on the parsed primitives only - searchParams is a fresh object
		// each render and would re-run this fetch effect unnecessarily.
	}, [linkId, username, amountParam, currencyParam, refParam, walletParam, t]);

	// Balance for the "tu saldo" line (non-blocking).
	useEffect(() => {
		if (!user) return;
		(async () => {
			try {
				const data = await apiFetch<{ tokens?: Record<string, string>; usdc?: string; eth?: string }>(
					"/user/balance",
					{ user },
				);
				setBalances(data.tokens || { USDC: data.usdc ?? "", ETH: data.eth ?? "" });
			} catch {
				/* non-blocking */
			}
		})();
	}, [user]);

	// History with this recipient - "3 pagos, último el martes" turns the empty
	// profile page into a relationship (non-blocking enhancement).
	useEffect(() => {
		const targetWallet = linkData?.wallet;
		if (!user || !username || !targetWallet) return;
		(async () => {
			try {
				const data = await apiFetch<Parameters<typeof parseTransactions>[0]>(
					"/user/transactions",
					{ user },
				);
				const target = targetWallet.toLowerCase();
				const sentTo = parseTransactions(data).filter(
					(tx) => tx.type === "sent" && tx.to?.toLowerCase() === target,
				);
				setPayHistory({ count: sentTo.length, last: sentTo[0] ?? null });
			} catch {
				/* non-blocking */
			}
		})();
	}, [user, username, linkData?.wallet]);

	// Contacts for the one-tap row (manual mode only; non-blocking).
	useEffect(() => {
		if (!user || !manualMode) return;
		(async () => {
			try {
				const data = await apiFetch<{ contacts?: { id: string; username: string; alias: string | null }[] }>(
					"/contacts",
					{ user },
				);
				setContacts((data.contacts ?? []).slice(0, 8));
			} catch {
				/* non-blocking */
			}
		})();
	}, [user, manualMode]);

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
			const submit = await submitUserOp(user, userOpHash, assertion);
			const to = params.linkId === "username" ? linkData?.username || params.wallet : params.wallet;
			track("payment_sent", { currency: params.currency, via: params.linkId });
			// Not confirmed yet (broadcast timed out / duplicate submit): the status
			// page keeps polling and flips to the receipt when the payment settles.
			const q = new URLSearchParams({ amount: params.amount, currency: params.currency, to });
			if (submit.txHash) q.set("tx", submit.txHash);
			if (!submit.confirmed) {
				q.set("pending", "1");
				q.set("uoh", userOpHash);
			}
			navigate(`/pay/status?${q.toString()}`);
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
				// "No key on this device" won't be fixed by retrying - point at the
				// recovery door instead (signed-in users only; /recover needs auth).
				const noKeyOnDevice = msg === t("pay.errNoPasskeys", { host: APP_HOST });
				notifyError(
					new ApiError(msg, {
						status: 400,
						requestId: err instanceof ApiError ? err.requestId : undefined,
					}),
					t("pay.payError"),
					noKeyOnDevice && user
						? { title: t("recover.bannerCta"), onClick: () => navigate("/recover") }
						: { title: t("common.retry"), onClick: () => void executePay(params) },
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
			<Screen animate={false}>
				<StageOverlay label={payStage === "idle" ? null : stageCopy[payStage]} spinner={payStage !== "signing"} />
				{confirmTx && (
					<ConfirmSheet
						title={t("pay.confirmTitle")}
						amountLabel={t("pay.youWillSend")}
						amount={formatAmount(confirmTx.amount, confirmTx.currency)}
						unit={confirmTx.currency}
						warning={t("pay.confirmWarning")}
						confirmLabel={t("pay.confirmAndPay")}
						onConfirm={confirmAndPay}
						onCancel={() => setConfirmTx(null)}
					>
						<ConfirmDestination tx={confirmTx} />
					</ConfirmSheet>
				)}
				<BackHeader onClick={() => navigate("/")} title={t("pay.payOrSend")} className="mb-6" />

				<TrustBadge />

				<div className="flex flex-col items-center mb-6">
					<AmountInput
						name="amount"
						aria-label={t("pay.amountLabel")}
						placeholder="0"
						value={payAmount}
						onChange={setPayAmount}
						className={bigInput}
					/>
					<div className="seg-track mt-4">
						{activeNetwork.currencies.map((c) => (
							<button
								key={c}
								onClick={() => setPayCurrency(c)}
								aria-pressed={payCurrency === c}
								data-active={payCurrency === c}
								className="seg-item"
							>
								{c}
							</button>
						))}
					</div>
					{user && balances[payCurrency] !== undefined && (
						<p className="text-[12px] text-text-faint mt-3">
							{t("pay.yourBalance", { balance: formatAmount(balances[payCurrency], payCurrency), currency: payCurrency })}
						</p>
					)}
				</div>

				{/* One-tap destinations: contacts pay without typing (UX_DESIGN §4.3). */}
				{user && contacts.length > 0 && (
					<div className="mb-5">
						<p className="text-[11px] uppercase tracking-[0.1em] text-text-faint mb-3 px-1">
							{t("pay.yourContacts")}
						</p>
						<div className="flex gap-3 overflow-x-auto -mx-1 px-1 pb-1">
							{contacts.map((c) => (
								<button
									key={c.id}
									onClick={() => navigate(`/${c.username}`)}
									className="flex flex-col items-center gap-1.5 shrink-0 w-16"
								>
									<span className="w-12 h-12 rounded-full bg-pink/15 flex items-center justify-center font-display text-[18px] text-glow-pink uppercase">
										{(c.alias || c.username)[0]}
									</span>
									<span className="text-[11px] text-text-muted truncate w-full text-center">
										{c.alias || c.username}
									</span>
								</button>
							))}
						</div>
					</div>
				)}

				<div className="bg-surface border border-border rounded-[18px] p-5 mb-5 shadow-e1">
					<div className="seg-track seg-track-block mb-4">
						{(["username", "address"] as const).map((dt) => (
							<button
								key={dt}
								onClick={() => {
									setDestType(dt);
									setManualWallet("");
								}}
								aria-pressed={destType === dt}
								data-active={destType === dt}
								className="seg-item"
							>
								{dt === "address" ? t("pay.wallet") : t("pay.user")}
							</button>
						))}
					</div>
					<input
						type="text"
						name="destination"
						autoComplete="off"
						aria-label={destType === "address" ? t("pay.wallet") : t("pay.user")}
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

				{error && (
					<p role="status" aria-live="polite" className="text-glow-pink text-[13px] text-center mb-4">
						{error}
					</p>
				)}

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
					<p role="status" aria-live="polite" className="text-text-faint text-[12px] text-center mt-3 animate-fade-in">
						{t("pay.amountMustBePositive")}
					</p>
				)}
				{user && (
					<div className="mt-8">
						<p className="text-[11px] uppercase tracking-[0.1em] text-text-faint mb-3 px-1">
							{t("pay.otherOptions")}
						</p>
						<OptionCard
							accent="#f4a9cf"
							title={t("pay.sendOtherNetwork")}
							desc={t("pay.sendOtherNetworkDesc")}
							to="/crosschain"
							icon={
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="M7 17 17 7" />
									<path d="M7 7h10v10" />
								</svg>
							}
						/>
					</div>
				)}
			</Screen>
		);
	}

	if (!linkData) return null;

	const isStoredLink = !["direct", "username", "manual"].includes(linkData.id);
	const hasFixedAmount = Number(linkData.amount) > 0;
	const recipientLabel = linkData.username
		? `@${linkData.username}`
		: linkData.wallet
		? `${linkData.wallet.slice(0, 6)}…${linkData.wallet.slice(-4)}`
		: t("pay.thisAccount");

	// Username profile page
	if (username && userProfile && !showPayForm) {
		return (
			<Screen animate={false}>
				<BackHeader onClick={() => navigate("/")} className="mb-6" />
				<div className="flex-1 flex flex-col items-center justify-center text-center animate-fade-up">
					<div className="w-20 h-20 rounded-full bg-pink/15 flex items-center justify-center font-display text-[32px] text-glow-pink uppercase mb-5">
						{(userProfile.displayName || userProfile.username)[0]}
					</div>
					<h1 className="font-display text-[28px] mb-1">
						{userProfile.displayName || `@${userProfile.username}`}
					</h1>
					{userProfile.displayName && (
						<p className="text-[15px] text-text-muted mb-1">@{userProfile.username}</p>
					)}
					<p className="text-[14px] text-text-muted">{t("pay.receivesPaymentsOn", { network: activeNetwork.name })}</p>
					{userProfile.socialUrl && (
						<a
							href={userProfile.socialUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="mt-3 text-[13px] text-glow-sky underline underline-offset-2 break-all px-6"
						>
							{socialLabel(userProfile.socialUrl)}
						</a>
					)}
					{user && payHistory && (
						payHistory.count > 0 && payHistory.last ? (
							<div className="mt-6 bg-surface border border-border rounded-[16px] px-5 py-3.5">
								<p className="text-[13px] text-text-muted">
									{t("pay.paidBefore", { count: payHistory.count })}
								</p>
								<p className="text-[12px] text-text-faint mt-0.5">
									{t("pay.lastPayment", {
										amount: formatAmount(payHistory.last.amount, payHistory.last.currency),
										currency: payHistory.last.currency,
										date: formatShortDate(payHistory.last.createdAt),
									})}
								</p>
							</div>
						) : (
							<p className="mt-6 text-[13px] text-text-faint">{t("pay.firstTime")}</p>
						)
					)}
				</div>
				<button
					onClick={() => (user ? setShowPayForm(true) : handleLogin())}
					className="btn btn-primary btn-block"
				>
					{user ? t("pay.payTo", { name: userProfile.username }) : t("pay.signInToPay")}
				</button>
			</Screen>
		);
	}

	// Paid link
	if (linkData.status === "paid") {
		return (
			<Screen animate={false}>
				<BackHeader onClick={() => navigate("/")} className="mb-6" />
				<TxResult
					state="success"
					lead={t("pay.alreadyPaid")}
					amount={formatAmount(linkData.amount, linkData.currency)}
					unit={linkData.currency}
				>
					{linkData.reference && <p className="text-text-muted text-[14px] mt-3">{linkData.reference}</p>}
				</TxResult>
			</Screen>
		);
	}

	// Payment form (fixed link, open link, or username transfer)
	const isOpenAmount = !hasFixedAmount;
	const payingCurrency = isStoredLink || hasFixedAmount ? linkData.currency : payCurrency;

	return (
		<Screen animate={false}>
			<StageOverlay label={payStage === "idle" ? null : stageCopy[payStage]} spinner={payStage !== "signing"} />
			<BackHeader onClick={() => (showPayForm ? setShowPayForm(false) : navigate("/"))} className="mb-6" />

			<TrustBadge />
			<Recipient label={recipientLabel} name={linkData.username ? userProfile?.displayName : null} />

			{/* Amount */}
			<div className="flex flex-col items-center mb-6">
				{hasFixedAmount ? (
					<p className="font-display text-[56px] leading-tight tabular max-w-full break-words text-center">
						{formatAmount(linkData.amount, linkData.currency)}
						<span className="text-text-muted text-[24px] ml-2">{linkData.currency}</span>
					</p>
				) : (
					<>
						<AmountInput
							name="amount"
							aria-label={t("pay.amountLabel")}
							placeholder="0"
							value={payAmount}
							onChange={setPayAmount}
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
										aria-pressed={value === c}
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
				{user && balances[payingCurrency] !== undefined && (
					<p className="text-[12px] text-text-faint mt-3">
						{t("pay.yourBalance", { balance: formatAmount(balances[payingCurrency], payingCurrency), currency: payingCurrency })}
					</p>
				)}
			</div>

			{linkData.reference && (
				<p className="text-text-muted text-[14px] text-center mb-6 px-4 leading-relaxed">
					{linkData.reference}
				</p>
			)}

			<p className="text-[12px] text-text-faint text-center mb-5">{t("common.noNetworkFees")}</p>

			{error && (
				<p role="status" aria-live="polite" className="text-glow-pink text-[13px] text-center mb-4">
					{error}
				</p>
			)}

			{!user ? (
				<button onClick={handleLogin} className="btn btn-primary btn-block">
					{t("pay.signInToPay")}
				</button>
			) : (
				<button
					onClick={handlePay}
					disabled={paying || (isOpenAmount && !payAmount)}
					className="btn btn-gradient btn-block"
				>
					{t("common.pay")}
				</button>
			)}
			{slowConnection && paying && (
				<p role="status" aria-live="polite" className="text-text-faint text-[12px] text-center mt-3 animate-fade-in">
					{t("pay.networkSlow")}
				</p>
			)}
		</Screen>
	);
}

import { useEffect, useState } from "react";
import { useSearchParams, useParams } from "react-router";
import { ApiError, SERVER_URL, apiFetch } from "../lib/api";
import { isUserCancelled, notifyError, notifyWarning } from "../lib/notify";
import { track } from "../lib/analytics";
import { signInWithGoogle, type User } from "../lib/firebase";
import Logo from "../components/Logo";
import { signWithPasskey } from "../lib/webauthn";
import { submitUserOp } from "../lib/submit";
import { activeNetwork } from "../lib/activeNetwork";
import { userOperationChallenge, type PreparedUserOperation } from "../lib/eip712";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { useTranslation } from "react-i18next";
import { formatAmount } from "../lib/format";
import { parseTransactions, formatShortDate, type Transaction } from "../lib/transactions";
import OptionCard from "../components/OptionCard";
import LinkButton from "../components/LinkButton";
import AmountInput from "../components/AmountInput";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import StageOverlay from "../components/StageOverlay";
import ConfirmSheet from "../components/ConfirmSheet";
import TxResult from "../components/TxResult";
import { Skeleton } from "../components/Skeleton";
import SigningDetails from "../components/SigningDetails";
import { MoneyPanel, PanelActions, SectionLabel, TransactionActions } from "../components/finance/FinancialPrimitives";
import TokenSelect from "../components/TokenSelect";
import { APP_URL } from "../lib/brand";

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
	linkId: string;
	wallet: string;
	amount: string;
	currency: string;
	isAddress: boolean;
	username?: string;
	prepared: PreparedUserOperation;
};

/** Anti-phishing trust seal - always visible when paying. */
function TrustBadge() {
	const { t } = useTranslation();
	return (
		<div className="flex items-center justify-center gap-2 mb-7">
			<Logo className="w-6" />
			<span className="text-[13px] text-text-muted">
				{t("pay.secureWith")} <span className="text-text font-medium">GatoPago</span>
			</span>
		</div>
	);
}

function Recipient({ label, name }: { label: string; name?: string | null }) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col items-center gap-2 mb-6">
			<div className="flex h-12 w-12 items-center justify-center border-2 border-text bg-cat-500 font-display text-[18px] uppercase text-on-cat shadow-[4px_4px_0_var(--color-cat-700)]">
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
		<div className="mb-3 border border-border bg-surface px-4 py-3">
			<span className="text-[12px] text-text-muted block mb-1">{t("pay.to")}</span>
			{tx.isAddress ? (
				<span className="text-[13px] text-text font-mono break-all">{tx.wallet}</span>
			) : (
				<span className="flex flex-col gap-1">
					<span className="text-[15px] text-text">@{tx.username}</span>
					<span className="text-[11px] text-text-faint font-mono break-all">{tx.wallet}</span>
				</span>
			)}
		</div>
	);
}

export default function PayPage({ user }: { user: User | null }) {
	const [searchParams] = useSearchParams();
	const { username } = useParams();
	const navigate = useViewTransitionNavigate();
	const { t } = useTranslation();
	const withdrawIntent = searchParams.get("intent") === "withdraw";
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
	const [destType, setDestType] = useState<"address" | "username">(withdrawIntent ? "address" : "username");
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
	const recipientParam = searchParams.get("recipient");

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
		} else if (recipientParam && /^0x[a-fA-F0-9]{40}$/.test(recipientParam)) {
			setManualMode(true);
			setDestType("address");
			setManualWallet(recipientParam);
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
	}, [linkId, username, amountParam, currencyParam, refParam, walletParam, recipientParam, t]);

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

	type PaymentParams = { linkId: string; wallet: string; amount: string; currency: string };

	/** Prepare first so the review sheet can show the exact EIP-712 document. */
	async function preparePay(params: PaymentParams, recipient: { isAddress: boolean; username?: string }) {
		if (!user) return;
		setPaying(true);
		setError("");
		setPayStage("preparing");
		const paySlowTimer = setTimeout(() => setSlowConnection(true), 6000);
		try {
			const prepared = await apiFetch<PreparedUserOperation>("/pay/prepare", { user, body: params });
			userOperationChallenge(prepared, activeNetwork.chainId);
			setConfirmTx({ ...params, ...recipient, prepared });
		} catch (err) {
			reportPayError(err, () => void preparePay(params, recipient));
		} finally {
			clearTimeout(paySlowTimer);
			setSlowConnection(false);
			setPaying(false);
			setPayStage("idle");
		}
	}

	/** The passkey is invoked only after the user accepts the reviewed payload. */
	async function executePreparedPay(tx: ManualConfirm) {
		if (!user) return;
		setConfirmTx(null);
		setPaying(true);
		setError("");
		try {
			setPayStage("signing");
			const assertion = await signWithPasskey(
				userOperationChallenge(tx.prepared, activeNetwork.chainId),
				tx.prepared.credentialId,
			);
			setPayStage("securing");
			const submit = await submitUserOp(user, tx.prepared.userOpHash, assertion);
			const to = tx.username || tx.wallet;
			track("payment_sent", { currency: tx.currency, via: tx.linkId });
			const q = new URLSearchParams({ amount: tx.amount, currency: tx.currency, to });
			if (submit.txHash) q.set("tx", submit.txHash);
			if (!submit.confirmed) {
				q.set("pending", "1");
				q.set("uoh", tx.prepared.userOpHash);
			}
			navigate(`/pay/status?${q.toString()}`);
		} catch (err) {
			reportPayError(err, () => void preparePay(tx, { isAddress: tx.isAddress, username: tx.username }));
		} finally {
			setPaying(false);
			setPayStage("idle");
		}
	}

	function reportPayError(err: unknown, retry: () => void) {
		if (isUserCancelled(err)) {
			notifyWarning(t("notify.cancelled"), t("pay.paymentNotMade"));
			setError("");
			return;
		}
		const code = err instanceof ApiError ? err.code : undefined;
		const msg = code
			? t(`err.${code}`, { defaultValue: err instanceof Error ? err.message : t("pay.processError") })
			: parsePaymentError(err instanceof Error ? err.message : t("pay.processError"));
		const noKeyOnDevice = msg === t("pay.errNoPasskeys", { host: APP_HOST });
		notifyError(
			new ApiError(msg, {
				status: 400,
				requestId: err instanceof ApiError ? err.requestId : undefined,
			}),
			t("pay.payError"),
			noKeyOnDevice && user
				? { title: t("recover.bannerCta"), onClick: () => navigate("/recover") }
				: { title: t("common.retry"), onClick: retry },
		);
		setError(msg);
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
		await preparePay(
			{ linkId: linkData.id, wallet: linkData.wallet, amount, currency },
			{ isAddress: !linkData.username, username: linkData.username },
		);
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

		await preparePay(
			{ linkId: "manual", wallet: targetWallet, amount: payAmount, currency: payCurrency },
			{
				isAddress: destType === "address",
				username: destType === "username" ? manualWallet.trim().toLowerCase() : undefined,
			},
		);
	}

	async function confirmAndPay() {
		if (!confirmTx) return;
		await executePreparedPay(confirmTx);
	}

	function confirmationSheet() {
		if (!confirmTx) return null;
		return (
			<ConfirmSheet
				title={manualMode ? t("pay.confirmSendTitle") : t("pay.confirmTitle")}
				amountLabel={t("pay.youWillSend")}
				amount={formatAmount(confirmTx.amount, confirmTx.currency)}
				unit={confirmTx.currency}
				warning={t("pay.confirmWarning")}
				confirmLabel={manualMode ? t("pay.confirmAndSend") : t("pay.confirmAndPay")}
				paymentAction={!manualMode}
				onConfirm={() => void confirmAndPay()}
				onCancel={() => setConfirmTx(null)}
			>
				<ConfirmDestination tx={confirmTx} />
				<SigningDetails payload={confirmTx.prepared.signingPayload} networkName={activeNetwork.name} />
			</ConfirmSheet>
		);
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
			<Screen animate={false} aria-busy="true">
				<div className="flex flex-col items-center mb-7" aria-hidden="true">
					<Logo className="w-11 mb-4 opacity-75" />
					<Skeleton className="h-3.5 w-24 rounded-[6px] mb-2" />
					<Skeleton className="h-7 w-36 rounded-[9px]" />
				</div>
				<div className="mb-4 rounded-[20px] bg-surface p-6" aria-hidden="true">
					<Skeleton className="h-3 w-24 rounded-[6px] mx-auto mb-5" />
					<Skeleton className="h-14 w-48 rounded-[14px] mx-auto mb-5" />
					<Skeleton className="h-3 w-32 rounded-[6px] mx-auto" />
				</div>
				<div className="flex-1" />
				<Skeleton className="h-12 w-full rounded-full" />
				<p role="status" aria-live="polite" className={`text-center mt-4 text-[13px] ${slowConnection ? "text-text-muted" : "sr-only"}`}>
					{slowConnection ? t("pay.slowConnection") : t("common.loading")}
				</p>
			</Screen>
		);
	}

	if (error && !linkData) {
		return (
			<Screen animate={false} className="items-center justify-center gap-5 px-8 text-center">
				<Logo className="w-14 opacity-50" />
				<p className="text-text text-[16px] max-w-[280px]">{error}</p>
				<button onClick={() => navigate("/", { replace: true })} className="btn btn-primary btn-sm">
					{t("pay.goHome")}
				</button>
			</Screen>
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
				{confirmationSheet()}
				<BackHeader title={withdrawIntent ? t("pay.withdrawTitle") : t("pay.sendTitle")} className="mb-6" />

				<TrustBadge />

				<MoneyPanel className="flex flex-col items-center mb-6">
					<AmountInput
						name="amount"
						aria-label={t("pay.amountLabel")}
						placeholder="0"
						value={payAmount}
						onChange={setPayAmount}
						className={bigInput}
					/>
					<TokenSelect value={payCurrency} options={activeNetwork.currencies} balances={balances} onChange={setPayCurrency} className="mt-4" />
					{user && balances[payCurrency] !== undefined && (
						<p className="text-[12px] text-text-faint mt-3">
							{t("pay.yourBalance", { balance: formatAmount(balances[payCurrency], payCurrency), currency: payCurrency })}
						</p>
					)}
				</MoneyPanel>

				{/* One-tap destinations: contacts pay without typing (UX_DESIGN §4.3). */}
				{user && contacts.length > 0 && (
					<div className="mb-5">
						<SectionLabel>{t("pay.yourContacts")}</SectionLabel>
						<div className="flex gap-3 overflow-x-auto -mx-1 px-1 pb-1">
							{contacts.map((c) => (
								<LinkButton
									key={c.id}
									to={`/${c.username}`}
									className="flex flex-col items-center gap-1.5 shrink-0 w-16"
								>
									<span className="flex h-12 w-12 items-center justify-center border border-text bg-cat-500 font-display text-[18px] uppercase text-on-cat shadow-[3px_3px_0_var(--color-cat-700)]">
										{(c.alias || c.username)[0]}
									</span>
									<span className="text-[11px] text-text-muted truncate w-full text-center">
										{c.alias || c.username}
									</span>
								</LinkButton>
							))}
						</div>
					</div>
				)}

				<MoneyPanel className="mb-5">
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
								{dt === "address" ? t("pay.walletDestination") : t("pay.gatoPagoDestination")}
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
						className={`meli-field h-12 text-[14px] placeholder:text-text-faint ${destType === "address" ? "font-mono" : ""}`}
					/>
					<p className="mt-3 text-[12px] leading-relaxed text-text-muted">
						{destType === "username"
							? t("pay.gatoPagoDestinationHint")
							: t("pay.walletDestinationHint", { network: activeNetwork.name })}
					</p>
					{destType === "address" ? (
						<div className="mt-4 flex items-center justify-between border border-border bg-surface-2 px-3.5 py-3 text-[12px]">
							<span className="text-text-faint">{t("pay.sendNetwork")}</span>
							<span className="text-text">{activeNetwork.name}</span>
						</div>
					) : null}
				</MoneyPanel>

				{error && (
					<p role="status" aria-live="polite" className="mb-4 text-center text-[13px] text-danger">
						{error}
					</p>
				)}

				<PanelActions>
					{!user ? (
						<button onClick={handleLogin} className="btn btn-primary btn-block">
							{t("pay.signInToPay")}
						</button>
					) : (
						<button
							onClick={handleManualPay}
							disabled={paying || resolvingUsername || !manualWallet || manualAmountInvalid}
							className="btn btn-primary btn-block"
						>
							{resolvingUsername ? t("pay.searchingUser") : withdrawIntent ? t("pay.withdrawAction") : t("pay.sendAction")}
						</button>
					)}
					{showAmountHint && (
						<p role="status" aria-live="polite" className="text-text-faint text-[12px] text-center mt-3 animate-fade-in">
							{t("pay.amountMustBePositive")}
						</p>
					)}
				</PanelActions>
				{user && (
					<div className="mt-8">
						<SectionLabel>{t("pay.otherOptions")}</SectionLabel>
						<OptionCard
							tone="brand"
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
				<BackHeader className="mb-6" />
				<div className="flex-1 flex flex-col items-center justify-center text-center animate-fade-up">
					<div className="mb-5 flex h-20 w-20 items-center justify-center border-2 border-text bg-cat-500 font-display text-[32px] uppercase text-on-cat shadow-[6px_6px_0_var(--color-cat-700)]">
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
							className="mt-3 break-all px-6 text-[13px] text-info underline underline-offset-2"
						>
							{socialLabel(userProfile.socialUrl)}
						</a>
					)}
					{user && payHistory && (
						payHistory.count > 0 && payHistory.last ? (
							<div className="meli-paper-card meli-paper-card--strong mt-6 px-5 py-3.5">
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
				<BackHeader onClick={() => navigate("/", { replace: true })} className="mb-6" />
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
			{confirmationSheet()}
			<BackHeader onClick={showPayForm ? () => setShowPayForm(false) : undefined} className="mb-6" />

			<TrustBadge />
			<Recipient label={recipientLabel} name={linkData.username ? userProfile?.displayName : null} />

			{/* Amount */}
			<MoneyPanel className="flex flex-col items-center mb-6">
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
						<TokenSelect
							value={isStoredLink ? linkData.currency : payCurrency}
							options={activeNetwork.currencies}
							balances={balances}
							onChange={setPayCurrency}
							disabled={isStoredLink}
							className="mt-4"
						/>
						<p className="text-[12px] text-text-faint mt-3">{t("pay.chooseCurrency")}</p>
					</>
				)}
				{user && balances[payingCurrency] !== undefined && (
					<p className="text-[12px] text-text-faint mt-3">
						{t("pay.yourBalance", { balance: formatAmount(balances[payingCurrency], payingCurrency), currency: payingCurrency })}
					</p>
				)}
			</MoneyPanel>

			{linkData.reference && (
				<p className="text-text-muted text-[14px] text-center mb-6 px-4 leading-relaxed">
					{linkData.reference}
				</p>
			)}

			{error && (
				<p role="status" aria-live="polite" className="mb-4 text-center text-[13px] text-danger">
					{error}
				</p>
			)}

			<TransactionActions hint={t("common.noNetworkFees")}>
				{!user ? (
					<button onClick={handleLogin} className="btn btn-primary btn-block">
						{t("pay.signInToPay")}
					</button>
				) : (
					<button
						onClick={handlePay}
						disabled={paying || (isOpenAmount && !payAmount)}
						className="btn btn-money btn-block"
					>
						{t("common.pay")}
					</button>
				)}
			</TransactionActions>
			{slowConnection && paying && (
				<p role="status" aria-live="polite" className="text-text-faint text-[12px] text-center mt-3 animate-fade-in">
					{t("pay.networkSlow")}
				</p>
			)}
		</Screen>
	);
}

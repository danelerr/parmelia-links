import { useCallback, useEffect, useState } from "react";
import { useSearchParams, useParams } from "react-router";
import { ApiError, SERVER_URL, apiFetch } from "../lib/api";
import { isUserCancelled, notifyError, notifyWarning } from "../lib/notify";
import { track } from "../lib/analytics";
import { signInWithGoogle, type User } from "../lib/firebase";
import { signWithPasskey } from "../lib/webauthn";
import { submitUserOp } from "../lib/submit";
import { activeNetwork } from "../lib/activeNetwork";
import { DEFAULT_CHAIN_KEY, getNetworkConfig, isSupportedChainKey } from "../lib/networks";
import { userOperationChallenge, type PreparedUserOperation } from "../lib/eip712";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { usePasskeyGuidance } from "../hooks/usePasskeyGuidance";
import { useTranslation } from "react-i18next";
import { formatAmount } from "../lib/format";
import { parseTransactions, type Transaction } from "../lib/transactions";
import OptionCard from "../components/OptionCard";
import LinkButton from "../components/LinkButton";
import AmountInput from "../components/AmountInput";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import StageOverlay from "../components/StageOverlay";
import ConfirmSheet from "../components/ConfirmSheet";
import SigningDetails from "../components/SigningDetails";
import { MoneyPanel, PanelActions, SectionLabel, TransactionActions } from "../components/finance/FinancialPrimitives";
import TokenSelect from "../components/TokenSelect";
import NetworkChips from "../components/NetworkChips";
import NoticeCard from "../components/NoticeCard";
import { useChainPortfolio } from "../hooks/useChainPortfolio";
import { parsePaymentError } from "../lib/paymentErrors";
import ExternalWalletCheckout from "../features/checkout/ExternalWalletCheckout";
import PaymentMethodSelector, { type CheckoutPaymentMethod } from "../features/checkout/PaymentMethodSelector";
import { getCheckout } from "../features/checkout/api";
import type { CheckoutResponse } from "../features/checkout/types";
import {
	ConfirmPayDestination,
	PaidLinkView,
	PayLoadErrorView,
	PayLoadingView,
	PayRecipient,
	PayTrustBadge,
	UsernameProfileView,
	type LinkData,
	type ManualConfirm,
	type UserProfile,
} from "../components/pay/PayViews";

type PayStage = "idle" | "preparing" | "signing" | "securing";

export default function PayPage({ user }: { user: User | null }) {
	const [searchParams] = useSearchParams();
	const { username } = useParams();
	const requestIdentity = `${username ?? ""}?${searchParams.toString()}`;
	return <PayPageContent key={requestIdentity} user={user} />;
}

function PayPageContent({ user }: { user: User | null }) {
	const [searchParams] = useSearchParams();
	const { username } = useParams();
	const navigate = useViewTransitionNavigate();
	const guideToPasskeys = usePasskeyGuidance();
	const { t } = useTranslation();
	const {
		data: chainPortfolio,
		error: chainPortfolioError,
		isLoading: chainPortfolioLoading,
	} = useChainPortfolio(user);
	const linkId = searchParams.get("id");
	const amountParam = searchParams.get("amount");
	const currencyParam = searchParams.get("currency") || "USDC";
	const refParam = searchParams.get("ref");
	const walletParam = searchParams.get("wallet");
	const recipientParam = searchParams.get("recipient");
	const withdrawIntent = searchParams.get("intent") === "withdraw";
	const requestedChainKey = searchParams.get("chainKey");
	// A stored checkout settles through its own contract rail. Query-string
	// chain hints only apply to direct/user transfers and must never reroute a
	// checkout behind the merchant's back.
	const explicitRequestedChainKey = !linkId && requestedChainKey && isSupportedChainKey(requestedChainKey)
		? requestedChainKey
		: null;
	const hasExplicitChainRequest = !linkId && requestedChainKey !== null;
	const initialChainKey = hasExplicitChainRequest
		? requestedChainKey ?? DEFAULT_CHAIN_KEY
		: DEFAULT_CHAIN_KEY;
	const [selectedChainKey, setSelectedChainKey] = useState(initialChainKey);
	const [linkData, setLinkData] = useState<LinkData | null>(null);
	const [checkout, setCheckout] = useState<CheckoutResponse | null>(null);
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
	const [paymentMethod, setPaymentMethod] = useState<CheckoutPaymentMethod>("external");
	// Saved contacts, surfaced as one-tap destinations in manual mode.
	const [contacts, setContacts] = useState<{ id: string; username: string; alias: string | null }[]>([]);
	// Own balance, visible at the moment of paying (top ask from field testing).
	const [balances, setBalances] = useState<Record<string, string>>({});
	// Payment history with this recipient (derived client-side from the ledger's
	// to/from wallets). Signed-in users on the username profile page only.
	const [payHistory, setPayHistory] = useState<{ count: number; last: Transaction | null } | null>(null);
	const availableChains = chainPortfolio?.chains.filter((chain) =>
		chain.walletRailEnabled &&
		chain.rpcConfigured &&
		chain.account?.status === "active" &&
		chain.account.securityStatus === "current" &&
		chain.account.securityVersionApplied === chain.account.securityVersionDesired,
	) ?? [];
	const selectedChain = availableChains.find((chain) => chain.key === selectedChainKey)
		?? (hasExplicitChainRequest
			? null
			: availableChains.find((chain) => chain.key === DEFAULT_CHAIN_KEY)
				?? availableChains[0])
		?? null;
	const effectiveChainKey = selectedChain?.key
		?? (isSupportedChainKey(selectedChainKey) ? selectedChainKey : DEFAULT_CHAIN_KEY);
	const selectedNetwork = getNetworkConfig(effectiveChainKey);
	const requestedNetworkLabel = explicitRequestedChainKey
		? getNetworkConfig(explicitRequestedChainKey).name
		: hasExplicitChainRequest
			? requestedChainKey
			: selectedNetwork.name;
	const selectedCurrency = selectedNetwork.currencies.includes(payCurrency)
		? payCurrency
		: selectedNetwork.currencies[0] ?? "USDC";

	const stageCopy: Record<Exclude<PayStage, "idle">, string> = {
		preparing: t("pay.stagePreparing"),
		signing: t("pay.stageSigning"),
		securing: t("pay.stageSecuring"),
	};

	useEffect(() => {
		// Slow-connection hint scoped to the INITIAL fetch only: armed when a
		// request actually starts and disarmed the moment it settles, so it can't
		// fire while the user idles on the form. The submit flow arms its own
		// timer inside executePay.
		let cancelled = false;
		const controller = new AbortController();
		let slowTimer: ReturnType<typeof setTimeout> | null = null;
		function armSlowHint() {
			slowTimer = setTimeout(() => {
				if (!cancelled) setSlowConnection(true);
			}, 5000);
		}
		function disarmSlowHint() {
			if (slowTimer) clearTimeout(slowTimer);
			slowTimer = null;
			if (!cancelled) setSlowConnection(false);
		}

		async function fetchLink(id: string) {
			armSlowHint();
			try {
				const data = await getCheckout(id);
				if (cancelled) return;
				setCheckout(data);
				setLinkData({
					id: data.link.id,
					amount: data.intent.amount,
					amountMode: data.intent.amount_mode,
					currency: data.intent.currency,
					reference: data.intent.reference,
					wallet: data.link.wallet,
					status: data.intent.status === "paid" || data.intent.status === "overpaid" ? "paid" : "pending",
				});
				if (data.intent.amount_mode === "payer_defined" && data.intent.amount_atomic !== "0") {
					setPayAmount(data.intent.amount);
				}
			} catch (error) {
				if (!cancelled && !(error instanceof DOMException && error.name === "AbortError")) {
					setError(t("pay.linkNotFound"));
				}
			} finally {
				disarmSlowHint();
				if (!cancelled) setLoading(false);
			}
		}

	async function fetchByUsername(uname: string) {
			armSlowHint();
			try {
				const lookupChain = requestedChainKey && isSupportedChainKey(requestedChainKey)
					? requestedChainKey
					: DEFAULT_CHAIN_KEY;
				const res = await fetch(`${SERVER_URL}/user/${uname}?chainKey=${encodeURIComponent(lookupChain)}`, { signal: controller.signal });
				if (!res.ok) throw new Error("Usuario no encontrado");
				const data = await res.json();
				if (cancelled) return;
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
			} catch (error) {
				if (!cancelled && !(error instanceof DOMException && error.name === "AbortError")) {
					setError(t("pay.userNotFound"));
				}
			} finally {
				disarmSlowHint();
				if (!cancelled) setLoading(false);
			}
		}

		if (linkId) {
			fetchLink(linkId);
		} else if (username) {
			fetchByUsername(username);
		} else {
			queueMicrotask(() => {
				if (cancelled) return;
				if (amountParam) {
					setLinkData({
						id: "direct",
						amount: amountParam,
						currency: currencyParam,
						reference: refParam || "",
						wallet: walletParam || "",
						status: "pending",
					});
				} else {
					setManualMode(true);
					if (recipientParam && /^0x[a-fA-F0-9]{40}$/.test(recipientParam)) {
						setDestType("address");
						setManualWallet(recipientParam);
					}
				}
				setLoading(false);
			});
		}

		return () => {
			cancelled = true;
			controller.abort();
			if (slowTimer) clearTimeout(slowTimer);
		};
		// Depend on the parsed primitives only - searchParams is a fresh object
		// each render and would re-run this fetch effect unnecessarily.
	}, [linkId, username, amountParam, currencyParam, refParam, walletParam, recipientParam, requestedChainKey, t]);

	// Balance for the "tu saldo" line (non-blocking).
	useEffect(() => {
		if (!user || !selectedChain) return;
		(async () => {
			try {
				const data = await apiFetch<{ tokens?: Record<string, string>; usdc?: string; eth?: string; avax?: string }>(
					`/user/balance?chainKey=${encodeURIComponent(effectiveChainKey)}`,
					{ user },
				);
				setBalances(data.tokens || {
					USDC: data.usdc ?? "",
					[selectedNetwork.nativeTokenSymbol]: data.avax ?? data.eth ?? "",
				});
			} catch {
				/* non-blocking */
			}
		})();
	}, [effectiveChainKey, selectedChain, selectedNetwork.nativeTokenSymbol, user]);

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

	type PaymentParams = { linkId: string; wallet: string; amount: string; currency: string; chainKey: string };

	/** Prepare first so the review sheet can show the exact EIP-712 document. */
	async function preparePay(params: PaymentParams, recipient: { isAddress: boolean; username?: string }) {
		if (!user) return;
		const executionChain = availableChains.find((chain) => chain.key === params.chainKey);
		if (!executionChain) {
			const network = getNetworkConfig(params.chainKey);
			const message = t("pay.networkNotReadyDesc");
			notifyWarning(t("pay.networkNotReady", { network: network.name }), message);
			setError(message);
			return;
		}
		setPaying(true);
		setError("");
		setPayStage("preparing");
		const paySlowTimer = setTimeout(() => setSlowConnection(true), 6000);
		try {
			const prepared = await apiFetch<PreparedUserOperation>("/pay/prepare", { user, body: params });
			const network = getNetworkConfig(params.chainKey);
			userOperationChallenge(prepared, network.chainId);
			setConfirmTx({
				...params,
				...recipient,
				chainId: network.chainId,
				networkName: network.name,
				prepared,
			});
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
				userOperationChallenge(tx.prepared, tx.chainId),
				tx.prepared.credentialId,
				tx.prepared.rpId,
			);
			setPayStage("securing");
			const submit = await submitUserOp(user, tx.prepared.userOpHash, assertion);
			const to = tx.username || tx.wallet;
			track("payment_sent", { currency: tx.currency, via: tx.linkId });
			const q = new URLSearchParams({ amount: tx.amount, currency: tx.currency, to });
			q.set("chainKey", tx.chainKey);
			if (submit.txHash) q.set("tx", submit.txHash);
			if (!submit.confirmed) {
				q.set("pending", "1");
				q.set("uoh", tx.prepared.userOpHash);
			}
			navigate(`/pay/status?${q.toString()}`);
		} catch (err) {
			reportPayError(
				err,
				() => void preparePay(tx, { isAddress: tx.isAddress, username: tx.username }),
				tx.prepared.credentialId,
			);
		} finally {
			setPaying(false);
			setPayStage("idle");
		}
	}

	function reportPayError(
		err: unknown,
		retry: () => void,
		credentialId?: string | null,
	) {
		if (guideToPasskeys(err, credentialId)) {
			setError("");
			return;
		}
		if (isUserCancelled(err)) {
			notifyWarning(t("notify.cancelled"), t("pay.paymentNotMade"));
			setError("");
			return;
		}
		const code = err instanceof ApiError ? err.code : undefined;
		const msg = code
			? t(`err.${code}`, { defaultValue: err instanceof Error ? err.message : t("pay.processError") })
			: parsePaymentError(err instanceof Error ? err.message : t("pay.processError"), t);
		notifyError(
			new ApiError(msg, {
				status: 400,
				requestId: err instanceof ApiError ? err.requestId : undefined,
			}),
			t("pay.payError"),
			{ title: t("common.retry"), onClick: retry },
		);
		setError(msg);
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
			{
				linkId: linkData.id,
				wallet: linkData.wallet,
				amount,
				currency,
				chainKey: isStoredLink ? DEFAULT_CHAIN_KEY : effectiveChainKey,
			},
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
				const res = await fetch(
					`${SERVER_URL}/user/${manualWallet.trim().toLowerCase()}?chainKey=${encodeURIComponent(effectiveChainKey)}`,
				);
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
			{
				linkId: "manual",
				wallet: targetWallet,
				amount: payAmount,
				currency: selectedCurrency,
				chainKey: effectiveChainKey,
			},
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
				<ConfirmPayDestination tx={confirmTx} />
				<SigningDetails payload={confirmTx.prepared.signingPayload} networkName={confirmTx.networkName} />
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

	const handleExternalPaid = useCallback((settledAmount: string) => {
		setLinkData((current) => current ? { ...current, amount: settledAmount || current.amount, status: "paid" } : current);
	}, []);

	const bigInput =
		"w-full max-w-[260px] bg-transparent text-center font-display text-[56px] leading-none text-text placeholder:text-text-faint tabular";
	const chainReadinessNotice = user && !chainPortfolio ? (
		<NoticeCard tone={chainPortfolioError ? "warning" : "info"} title={t("pay.networkNotReady", { network: selectedNetwork.name })} className="mb-5">
			{chainPortfolioLoading && !chainPortfolioError
				? t("pay.networkLoading")
				: t("pay.networkNotReadyDesc")}
		</NoticeCard>
	) : user && !selectedChain ? (
		<NoticeCard tone="warning" title={t("pay.networkNotReady", { network: requestedNetworkLabel })} className="mb-5">
			{t("pay.networkNotReadyDesc")}
		</NoticeCard>
	) : null;

	if (loading) {
		return <PayLoadingView slowConnection={slowConnection} />;
	}

	if (error && !linkData) {
		return <PayLoadErrorView message={error} onHome={() => navigate("/", { replace: true })} />;
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

				<PayTrustBadge />

				<MoneyPanel className="flex flex-col items-center mb-6">
					<AmountInput
						name="amount"
						aria-label={t("pay.amountLabel")}
						placeholder="0"
						value={payAmount}
						onChange={setPayAmount}
						className={bigInput}
					/>
					<TokenSelect value={selectedCurrency} options={selectedNetwork.currencies} balances={balances} onChange={setPayCurrency} className="mt-4" />
					{user && balances[selectedCurrency] !== undefined && (
						<p className="text-[12px] text-text-faint mt-3">
							{t("pay.yourBalance", { balance: formatAmount(balances[selectedCurrency], selectedCurrency), currency: selectedCurrency })}
						</p>
					)}
				</MoneyPanel>

				{availableChains.length > 1 ? (
					<NetworkChips
						options={availableChains.map((chain) => ({ id: chain.chainId, label: chain.name }))}
						selected={selectedChain?.chainId ?? null}
						onSelect={(chainId) => {
							const next = availableChains.find((chain) => chain.chainId === chainId);
							if (!next || !isSupportedChainKey(next.key)) return;
							setSelectedChainKey(next.key);
							setPayCurrency(getNetworkConfig(next.key).currencies[0] ?? "USDC");
						}}
					/>
				) : null}
				{chainReadinessNotice}

				{/* One-tap destinations: contacts pay without typing (UX_DESIGN §4.3). */}
				{user && contacts.length > 0 && (
					<div className="mb-5">
						<SectionLabel>{t("pay.yourContacts")}</SectionLabel>
						<div className="flex gap-3 overflow-x-auto -mx-1 px-1 pb-1">
							{contacts.map((c) => (
								<LinkButton
									key={c.id}
									to={`/${c.username}?chainKey=${encodeURIComponent(effectiveChainKey)}`}
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
							: t("pay.walletDestinationHint", { network: selectedNetwork.name })}
					</p>
					{destType === "address" ? (
						<div className="mt-4 flex items-center justify-between border border-border bg-surface-2 px-3.5 py-3 text-[12px]">
							<span className="text-text-faint">{t("pay.sendNetwork")}</span>
							<span className="text-text">{selectedNetwork.name}</span>
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
							disabled={paying || resolvingUsername || !manualWallet || manualAmountInvalid || !selectedChain}
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
	const hasFixedAmount = linkData.amountMode ? linkData.amountMode === "fixed" : Number(linkData.amount) > 0;
	const recipientLabel = linkData.username
		? `@${linkData.username}`
		: linkData.wallet
		? `${linkData.wallet.slice(0, 6)}…${linkData.wallet.slice(-4)}`
		: t("pay.thisAccount");

	// Username profile page
	if (username && userProfile && !showPayForm) {
		return (
			<UsernameProfileView
				profile={userProfile}
				signedIn={Boolean(user)}
				payHistory={payHistory}
				onContinue={() => (user ? setShowPayForm(true) : void handleLogin())}
			/>
		);
	}

	// Paid link
	if (linkData.status === "paid") {
		return <PaidLinkView link={linkData} onHome={() => navigate("/", { replace: true })} />;
	}

	// Payment form (fixed link, open link, or username transfer)
	const isOpenAmount = !hasFixedAmount;
	const payingCurrency = isStoredLink || hasFixedAmount ? linkData.currency : selectedCurrency;
	const selectedAmount = hasFixedAmount ? linkData.amount : payAmount;

	return (
		<Screen animate={false}>
			<StageOverlay label={payStage === "idle" ? null : stageCopy[payStage]} spinner={payStage !== "signing"} />
			{confirmationSheet()}
			<BackHeader onClick={showPayForm ? () => setShowPayForm(false) : undefined} className="mb-6" />

			<PayTrustBadge />
			<PayRecipient label={recipientLabel} name={linkData.username ? userProfile?.displayName : null} />

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
							value={isStoredLink ? linkData.currency : selectedCurrency}
							options={isStoredLink ? activeNetwork.currencies : selectedNetwork.currencies}
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

			{isStoredLink && checkout && user ? (
				<PaymentMethodSelector value={paymentMethod} onChange={setPaymentMethod} />
			) : null}
			{user && (!isStoredLink || paymentMethod === "balance") ? chainReadinessNotice : null}

			{isStoredLink && checkout && (!user || paymentMethod === "external") ? (
				<ExternalWalletCheckout key={checkout.link.id} checkout={checkout} amount={selectedAmount} onPaid={handleExternalPaid} />
			) : (
				<TransactionActions hint={t("common.noNetworkFees")}>
					{!user ? (
						<button type="button" onClick={handleLogin} className="btn btn-primary btn-block">
							{t("pay.signInToPay")}
						</button>
					) : (
						<button
							type="button"
							onClick={handlePay}
							disabled={paying || (isOpenAmount && !payAmount) || !selectedChain}
							className="btn btn-money btn-block"
						>
							{t("common.pay")}
						</button>
					)}
				</TransactionActions>
			)}
			{slowConnection && paying && (
				<p role="status" aria-live="polite" className="text-text-faint text-[12px] text-center mt-3 animate-fade-in">
					{t("pay.networkSlow")}
				</p>
			)}
		</Screen>
	);
}

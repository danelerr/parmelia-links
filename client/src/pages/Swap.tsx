import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import type { User } from "../lib/firebase";
import { SERVER_URL, apiFetch } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import { humanizeError, notifyError } from "../lib/notify";
import { track } from "../lib/analytics";
import { signWithPasskey } from "../lib/webauthn";
import { submitUserOp } from "../lib/submit";
import { userOperationChallenge, type PreparedUserOperation } from "../lib/eip712";
import { activeNetwork, getExplorerTxUrl } from "../lib/activeNetwork";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { usePasskeyGuidance } from "../hooks/usePasskeyGuidance";
import { usePaymentStatus } from "../hooks/usePaymentStatus";
import { useTranslation } from "react-i18next";
import { formatAmount, formatNumber } from "../lib/format";
import Logo from "../components/Logo";
import AmountInput from "../components/AmountInput";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import StageOverlay from "../components/StageOverlay";
import TxResult from "../components/TxResult";
import ConfirmSheet from "../components/ConfirmSheet";
import SigningDetails from "../components/SigningDetails";
import TokenSelect from "../components/TokenSelect";
import type { HomeReadModel } from "../lib/homeData";
import {
	InsetPanel,
	MoneyPanel,
	SummaryRow,
	TransactionActions,
} from "../components/finance/FinancialPrimitives";

type SwapToken = { symbol: string; name: string; decimals: number; isNative: boolean };

type Quote = {
	quoteId: string;
	tokenIn: string;
	tokenOut: string;
	amountIn: string;
	amountOutEstimated: string;
	minimumAmountOut: string;
	gatoPagoFeeBps: number;
	gatoPagoFee: string;
	route: string;
	slippageBps: number;
	expiresAt: string;
	isMax: boolean;
};

type QuoteState = {
	key: string;
	quote: Quote | null;
	error: string;
	loading: boolean;
};

type SwapStage = "idle" | "preparing" | "signing" | "sending";

type PreparedSwap = PreparedUserOperation & {
	summary: {
		tokenIn: string;
		tokenOut: string;
		amountIn: string;
		minimumAmountOut: string;
		route: string;
		validUntil: string;
	};
};

function maxAmountForInput(value: string): string {
	const normalized = value.trim();
	if (!normalized.includes(".")) return normalized;
	return normalized.replace(/0+$/, "").replace(/\.$/, "") || "0";
}

export default function Swap({ user }: { user: User }) {
	const navigate = useViewTransitionNavigate();
	const guideToPasskeys = usePasskeyGuidance();
	const { t } = useTranslation();
	const [tokens, setTokens] = useState<SwapToken[]>([]);
	const [swapsEnabled, setSwapsEnabled] = useState(true);
	const [balances, setBalances] = useState<Record<string, string>>({});
	const [tokenIn, setTokenIn] = useState("USDC");
	const [tokenOut, setTokenOut] = useState("ETH");
	const [amount, setAmount] = useState("");
	const [useMax, setUseMax] = useState(false);
	const [quoteState, setQuoteState] = useState<QuoteState>({
		key: "",
		quote: null,
		error: "",
		loading: false,
	});
	const [stage, setStage] = useState<SwapStage>("idle");
	const [showDetails, setShowDetails] = useState(false);
	const [prepared, setPrepared] = useState<PreparedSwap | null>(null);
	const [result, setResult] = useState<{
		txHash: string | null;
		received: string;
		pending: boolean;
		userOpHash: string;
	} | null>(null);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const quoteSeqRef = useRef(0);
	const tokenInRef = useRef(tokenIn);
	const { data: homeModel } = useSWR<HomeReadModel>(`${SERVER_URL}/home`, null, {
		revalidateOnMount: false,
	});
	const visibleBalances = useMemo(
		() => ({ ...(homeModel?.balance.tokens ?? {}), ...balances }),
		[balances, homeModel?.balance.tokens],
	);
	const balanceIn = visibleBalances[tokenIn];

	useEffect(() => {
		tokenInRef.current = tokenIn;
	}, [tokenIn]);

	// When the submit came back in flight (202/duplicate), keep polling on the
	// success screen and flip the copy when the swap settles.
	const poll = usePaymentStatus(
		result?.pending ? user : null,
		result?.pending ? result.userOpHash : null,
	);

	const loadBalances = useCallback(async (fresh = false): Promise<Record<string, string> | null> => {
		try {
			const res = await fetchWithAuth(
				user,
				`${SERVER_URL}/user/balance${fresh ? "?fresh=1" : ""}`,
			);
			if (!res.ok) return null;
			const data = await res.json();
			const nextBalances = (data.tokens || { ETH: data.eth, USDC: data.usdc }) as Record<string, string>;
			setBalances(nextBalances);
			return nextBalances;
		} catch {
			/* non-blocking */
			return null;
		}
	}, [user]);

	// The balances only reflect the swap once it settles on-chain.
	useEffect(() => {
		if (poll.status === "included" || poll.status === "confirmed") {
			queueMicrotask(() => void loadBalances(true));
		}
	}, [poll.status, loadBalances]);

	useEffect(() => {
		(async () => {
			try {
				const res = await fetchWithAuth(user, `${SERVER_URL}/swap/tokens`);
				if (!res.ok) throw new Error();
				const data = await res.json();
				setTokens(data.tokens || []);
				setSwapsEnabled(!!data.swapsEnabled);
			} catch {
				setSwapsEnabled(false);
			}
		})();
		queueMicrotask(() => void loadBalances(true));
	}, [user, loadBalances]);

	const amountNumber = Number(amount);
	const quoteKey =
		((!useMax && amount && Number.isFinite(amountNumber) && amountNumber > 0) ||
			(useMax && balanceIn && Number(balanceIn) > 0)) &&
		tokenIn !== tokenOut
			? `${tokenIn}:${tokenOut}:${amount}:${useMax ? balanceIn : "manual"}:${useMax}`
			: null;
	const quote = quoteKey && quoteState.key === quoteKey ? quoteState.quote : null;
	const quoteError = quoteKey && quoteState.key === quoteKey ? quoteState.error : "";
	const quoting = Boolean(quoteKey) && (quoteState.key !== quoteKey || quoteState.loading);

	// Debounced quoting whenever the inputs change.
	useEffect(() => {
		const seq = ++quoteSeqRef.current;
		if (debounceRef.current) clearTimeout(debounceRef.current);
		if (!quoteKey) return;

		debounceRef.current = setTimeout(async () => {
			setQuoteState({ key: quoteKey, quote: null, error: "", loading: true });
			try {
				const data = await apiFetch<Quote>("/swap/quote", {
					user,
					// Keep a decimal amount for compatibility with older Workers. The
					// explicit flag lets current Workers resolve the live onchain max.
					body: { tokenIn, tokenOut, amountIn: amount, useMax },
				});
				if (seq !== quoteSeqRef.current) return;
				if (data.isMax) {
					const resolved = maxAmountForInput(data.amountIn);
					setAmount(resolved);
					setBalances((current) => ({ ...current, [data.tokenIn]: data.amountIn }));
				}
				setQuoteState({ key: quoteKey, quote: data, error: "", loading: false });
			} catch (err) {
				if (seq !== quoteSeqRef.current) return;
				setQuoteState({
					key: quoteKey,
					quote: null,
					error: humanizeError(err, t("swap.quoteError")).message,
					loading: false,
				});
			}
		}, 250);

		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [amount, quoteKey, tokenIn, tokenOut, useMax, user, t]);

	function flip() {
		setTokenIn(tokenOut);
		setTokenOut(tokenIn);
		if (useMax) {
			setAmount("");
			setUseMax(false);
		}
	}

	function handleUseAllBalance() {
		const requestedToken = tokenIn;
		const currentBalance = balanceIn;
		if (!currentBalance || Number(currentBalance) <= 0) return;
		setUseMax(true);
		setAmount(maxAmountForInput(currentBalance));
		// The quote endpoint resolves useMax from the live on-chain balance. Refresh
		// this display in parallel instead of making the control feel unresponsive.
		void loadBalances(true).then((latestBalances) => {
			if (tokenInRef.current !== requestedToken) return;
			const latestBalance = latestBalances?.[requestedToken];
			if (!latestBalance || Number(latestBalance) <= 0) return;
			setUseMax(true);
			setAmount(maxAmountForInput(latestBalance));
		});
	}

	async function prepareForReview() {
		if (!quote) return;
		setStage("preparing");
		try {
			const prep = await apiFetch<PreparedSwap>(
				"/swap/prepare",
				{ user, body: { quoteId: quote.quoteId } },
			);
			userOperationChallenge(prep, activeNetwork.chainId);
			setPrepared(prep);
		} catch (err) {
			notifyError(err, t("swap.swapError"));
		} finally {
			setStage("idle");
		}
	}

	async function confirmAndSwap() {
		const prep = prepared;
		const reviewedQuote = quote;
		if (!prep || !reviewedQuote) return;
		setPrepared(null);
		try {
			setStage("signing");
			const assertion = await signWithPasskey(
				userOperationChallenge(prep, activeNetwork.chainId),
				prep.credentialId,
				prep.rpId,
			);

			setStage("sending");
			const submit = await submitUserOp(user, prep.userOpHash, assertion);

			track("swap_completed", { from: tokenIn, to: tokenOut });
			setResult({
				txHash: submit.txHash,
				received: reviewedQuote.amountOutEstimated,
				pending: !submit.confirmed,
				userOpHash: prep.userOpHash,
			});
			setAmount("");
			setUseMax(false);
			if (submit.confirmed) void loadBalances(true);
		} catch (err) {
			if (!guideToPasskeys(err, prep.credentialId)) {
				notifyError(err, t("swap.swapError"));
			}
		} finally {
			setStage("idle");
		}
	}

	const tokenOptions = tokens.map((t) => t.symbol);
	const stageCopy: Record<Exclude<SwapStage, "idle">, string> = {
		preparing: t("swap.stagePreparing"),
		signing: t("swap.stageSigning"),
		sending: t("swap.stageSending"),
	};

	// ===== Success screen (also hosts the in-flight and failed states) =====
	if (result) {
		const swapFailed = result.pending && poll.status === "failed";
		const settled =
			!result.pending ||
			poll.status === "included" ||
			poll.status === "confirmed";
		const effectiveTx = result.txHash ?? poll.txHash;
		return (
			<Screen>
				<BackHeader onClick={() => navigate("/", { replace: true })} className="" />
				<TxResult
					state={swapFailed ? "failed" : settled ? "success" : "pending"}
					lead={swapFailed ? t("swap.failedLead") : settled ? t("swap.successLead") : t("swap.pendingLead")}
					amount={formatNumber(result.received, 6)}
					unit={tokenOut}
					body={swapFailed ? t("swap.failedBody") : settled ? t("swap.fundsUpdated") : t("swap.pendingBody")}
				>
					{effectiveTx && (
						<a
							href={getExplorerTxUrl(effectiveTx)}
							target="_blank"
							rel="noopener noreferrer"
							className="text-text-faint text-[12px]"
						>
							{t("swap.viewOnNetwork")}
						</a>
					)}
				</TxResult>
				<button onClick={() => setResult(null)} className="btn btn-primary btn-block">
					{t("swap.doAnother")}
				</button>
			</Screen>
		);
	}

	return (
		<Screen>
			<StageOverlay label={stage === "idle" ? null : stageCopy[stage]} spinner={stage !== "signing"} />
			{prepared && quote ? (
				<ConfirmSheet
					title={t("swap.confirmTitle")}
					amountLabel={quote.isMax ? t("swap.allBalance") : t("swap.youSwap")}
					amount={formatNumber(prepared.summary.amountIn, prepared.summary.tokenIn === "USDC" ? 2 : 6)}
					unit={prepared.summary.tokenIn}
					warning={t("swap.confirmWarning")}
					confirmLabel={t("swap.confirmAction")}
					onConfirm={() => void confirmAndSwap()}
					onCancel={() => setPrepared(null)}
				>
					<InsetPanel className="mb-3">
						<SummaryRow label={t("swap.youReceiveEst")} value={`${formatNumber(quote.amountOutEstimated, 6)} ${quote.tokenOut}`} />
						<SummaryRow label={t("swap.minReceived")} value={`${formatNumber(prepared.summary.minimumAmountOut, 6)} ${prepared.summary.tokenOut}`} />
					</InsetPanel>
					<SigningDetails payload={prepared.signingPayload} networkName={activeNetwork.name} />
				</ConfirmSheet>
			) : null}
			<BackHeader title={t("swap.title")} />

			{!swapsEnabled ? (
				<div className="flex-1 flex flex-col items-center justify-center text-center px-6">
					<Logo className="w-12 mb-5 opacity-40" />
					<p className="text-[15px] text-text mb-1">{t("swap.disabledTitle")}</p>
					<p className="text-[13px] text-text-muted max-w-[260px] leading-relaxed">
						{t("swap.disabledBody", { network: activeNetwork.name })}
					</p>
				</div>
			) : (
				<>
					{/* From */}
					<MoneyPanel className="mb-2">
						<div className="flex items-center justify-between mb-3">
							<span className="text-[13px] text-text-muted">{t("swap.youSwap")}</span>
							{balanceIn !== undefined && (
								<button
									onClick={handleUseAllBalance}
									className="text-[12px] text-text-faint"
								>
									{t("swap.balanceUseAll", { balance: formatAmount(balanceIn, tokenIn) })}
								</button>
							)}
						</div>
						<div className="flex items-center gap-3">
							<AmountInput
								name="amount"
								aria-label={t("swap.youSwap")}
								placeholder="0"
								value={amount}
								onChange={(value) => {
									setAmount(value);
									setUseMax(false);
								}}
								className="flex-1 min-w-0 bg-transparent font-display text-[34px] leading-none text-text placeholder:text-text-faint tabular"
							/>
							<TokenSelect
								value={tokenIn}
								options={tokenOptions}
								balances={visibleBalances}
								onChange={(symbol) => {
									if (symbol === tokenOut) flip();
									else {
										setTokenIn(symbol);
										if (useMax) {
											setAmount("");
											setUseMax(false);
										}
									}
								}}
							/>
						</div>
					</MoneyPanel>

					{/* Flip */}
					<div className="flex justify-center -my-1 relative z-1">
						<button
							onClick={flip}
							aria-label={t("swap.flip")}
							className="meli-square-action h-10 w-10 bg-surface text-text"
						>
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="m7 4 0 16" />
								<path d="m3 8 4-4 4 4" />
								<path d="m17 20 0-16" />
								<path d="m13 16 4 4 4-4" />
							</svg>
						</button>
					</div>

					{/* To */}
					<MoneyPanel className="mt-2 mb-5">
						<div className="flex items-center justify-between mb-3">
							<span className="text-[13px] text-text-muted">{t("swap.youReceiveEst")}</span>
							{quoting && <span className="h-2 w-2 rounded-[2px] bg-cat-500 animate-pulse" />}
						</div>
						<div className="flex items-center gap-3">
							<p className="flex-1 min-w-0 font-display text-[34px] leading-none tabular truncate text-text">
								{quote
									? formatNumber(quote.amountOutEstimated, 6)
									: quoting
										? "…"
										: "0"}
							</p>
							<TokenSelect
								value={tokenOut}
								options={tokenOptions}
								balances={visibleBalances}
								onChange={(symbol) => {
									if (symbol === tokenIn) flip();
									else setTokenOut(symbol);
								}}
							/>
						</div>
					</MoneyPanel>

					{quoteError && (
						<p role="status" aria-live="polite" className="mb-4 text-center text-[13px] text-danger">
							{quoteError}
						</p>
					)}

					{quote && (
						<InsetPanel className="mb-5">
							<SummaryRow label={t("swap.minReceived")} value={`${formatNumber(quote.minimumAmountOut, 6)} ${quote.tokenOut}`} />
							<SummaryRow label={t("swap.networkFee")} value={t("swap.coveredByGatoPago")} valueClassName="text-growth" />
							{quote.gatoPagoFeeBps > 0 && (
								<SummaryRow
									label={t("swap.gatoPagoService", { pct: (quote.gatoPagoFeeBps / 100).toFixed(2) })}
									value={`${formatNumber(quote.gatoPagoFee, 6)} ${quote.tokenOut}`}
								/>
							)}
							<button
								onClick={() => setShowDetails(!showDetails)}
								className="mt-2.5 text-[12px] text-text-faint"
							>
								{showDetails ? t("swap.hideDetails") : t("swap.showDetails")}
							</button>
							{showDetails && (
								<div className="mt-2 pt-2 text-[12px] text-text-faint leading-relaxed">
									<p>{t("swap.route", { route: quote.route })}</p>
									<p>{t("swap.priceTolerance", { pct: (quote.slippageBps / 100).toFixed(2) })}</p>
									<p>{t("swap.network", { network: activeNetwork.name })}</p>
								</div>
							)}
						</InsetPanel>
					)}

					<TransactionActions hint={t("swap.confirmHint")}>
						<button
							onClick={() => void prepareForReview()}
							disabled={!quote || quoting || stage !== "idle"}
							className="btn btn-primary btn-block"
						>
							{quoting ? t("swap.findingRoute") : t("swap.swap")}
						</button>
					</TransactionActions>
				</>
			)}
		</Screen>
	);
}

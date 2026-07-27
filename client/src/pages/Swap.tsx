import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "../lib/firebase";
import { SERVER_URL, apiFetch } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import { humanizeError, notifyError } from "../lib/notify";
import { track } from "../lib/analytics";
import { signWithPasskey } from "../lib/webauthn";
import { submitUserOp } from "../lib/submit";
import { hexToBytes } from "../lib/hex";
import { activeNetwork, getExplorerTxUrl } from "../lib/activeNetwork";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { usePaymentStatus } from "../hooks/usePaymentStatus";
import { useTranslation } from "react-i18next";
import { formatAmount, formatNumber } from "../lib/format";
import Logo from "../components/Logo";
import AmountInput from "../components/AmountInput";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import StageOverlay from "../components/StageOverlay";
import TxResult from "../components/TxResult";

type SwapToken = { symbol: string; name: string; decimals: number; isNative: boolean };

type Quote = {
	quoteId: string;
	tokenIn: string;
	tokenOut: string;
	amountIn: string;
	amountOutEstimated: string;
	minimumAmountOut: string;
	parmeliaFeeBps: number;
	parmeliaFee: string;
	route: string;
	slippageBps: number;
	expiresAt: string;
};

type SwapStage = "idle" | "preparing" | "signing" | "sending";

export default function Swap({ user }: { user: User }) {
	const navigate = useViewTransitionNavigate();
	const { t } = useTranslation();
	const [tokens, setTokens] = useState<SwapToken[]>([]);
	const [swapsEnabled, setSwapsEnabled] = useState(true);
	const [balances, setBalances] = useState<Record<string, string>>({});
	const [tokenIn, setTokenIn] = useState("USDC");
	const [tokenOut, setTokenOut] = useState("ETH");
	const [amount, setAmount] = useState("");
	const [quote, setQuote] = useState<Quote | null>(null);
	const [quoting, setQuoting] = useState(false);
	const [quoteError, setQuoteError] = useState("");
	const [stage, setStage] = useState<SwapStage>("idle");
	const [showDetails, setShowDetails] = useState(false);
	const [result, setResult] = useState<{
		txHash: string | null;
		received: string;
		pending: boolean;
		userOpHash: string;
	} | null>(null);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// When the submit came back in flight (202/duplicate), keep polling on the
	// success screen and flip the copy when the swap settles.
	const poll = usePaymentStatus(
		result?.pending ? user : null,
		result?.pending ? result.userOpHash : null,
	);

	const loadBalances = useCallback(async (fresh = false) => {
		try {
			const res = await fetchWithAuth(
				user,
				`${SERVER_URL}/user/balance${fresh ? "?fresh=1" : ""}`,
			);
			if (!res.ok) return;
			const data = await res.json();
			setBalances(data.tokens || { ETH: data.eth, USDC: data.usdc });
		} catch {
			/* non-blocking */
		}
	}, [user]);

	// The balances only reflect the swap once it settles on-chain.
	useEffect(() => {
		if (poll.status === "included" || poll.status === "confirmed") {
			void loadBalances(true);
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
		void loadBalances(true);
	}, [user, loadBalances]);

	// Debounced quoting whenever the inputs change.
	useEffect(() => {
		setQuote(null);
		setQuoteError("");
		if (debounceRef.current) clearTimeout(debounceRef.current);
		const value = Number(amount);
		if (!amount || !Number.isFinite(value) || value <= 0 || tokenIn === tokenOut) return;

		debounceRef.current = setTimeout(async () => {
			setQuoting(true);
			try {
				const data = await apiFetch<Quote>("/swap/quote", {
					user,
					body: { tokenIn, tokenOut, amountIn: amount },
				});
				setQuote(data);
			} catch (err) {
				setQuoteError(humanizeError(err, t("swap.quoteError")).message);
			} finally {
				setQuoting(false);
			}
		}, 450);

		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [amount, tokenIn, tokenOut, user, t]);

	function flip() {
		setTokenIn(tokenOut);
		setTokenOut(tokenIn);
		setQuote(null);
	}

	async function handleSwap() {
		if (!quote) return;
		setStage("preparing");
		try {
			const prep = await apiFetch<{ userOpHash: string; credentialId: string | null }>(
				"/swap/prepare",
				{ user, body: { quoteId: quote.quoteId } },
			);

			setStage("signing");
			const assertion = await signWithPasskey(
				hexToBytes(prep.userOpHash as `0x${string}`),
				prep.credentialId,
			);

			setStage("sending");
			const submit = await submitUserOp(user, prep.userOpHash, assertion);

			track("swap_completed", { from: tokenIn, to: tokenOut });
			setResult({
				txHash: submit.txHash,
				received: quote.amountOutEstimated,
				pending: !submit.confirmed,
				userOpHash: prep.userOpHash,
			});
			setQuote(null);
			setAmount("");
			if (submit.confirmed) void loadBalances(true);
		} catch (err) {
			notifyError(err, t("swap.swapError"));
		} finally {
			setStage("idle");
		}
	}

	const balanceIn = balances[tokenIn];
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
				<BackHeader onClick={() => navigate("/")} className="" />
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
			<BackHeader onClick={() => navigate("/")} title={t("swap.title")} />

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
					<div className="bg-surface border border-border rounded-[18px] p-5 mb-2 shadow-e1">
						<div className="flex items-center justify-between mb-3">
							<span className="text-[13px] text-text-muted">{t("swap.youSwap")}</span>
							{balanceIn !== undefined && (
								<button
									onClick={() => setAmount(balanceIn)}
									className="text-[12px] text-text-faint hover:text-text-muted transition-colors"
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
								onChange={setAmount}
								className="flex-1 min-w-0 bg-transparent font-display text-[34px] leading-none text-text placeholder:text-text-faint tabular"
							/>
							<div className="seg-track shrink-0">
								{tokenOptions.map((s) => (
									<button
										key={s}
										onClick={() => {
											if (s === tokenOut) flip();
											else setTokenIn(s);
										}}
										aria-pressed={tokenIn === s}
										data-active={tokenIn === s}
										className="seg-item"
									>
										{s}
									</button>
								))}
							</div>
						</div>
					</div>

					{/* Flip */}
					<div className="flex justify-center -my-1 relative z-1">
						<button
							onClick={flip}
							aria-label={t("swap.flip")}
							className="w-10 h-10 rounded-full bg-surface-2 border border-border-strong flex items-center justify-center text-text-muted hover:text-text transition-colors"
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
					<div className="bg-surface border border-border rounded-[18px] p-5 mt-2 mb-5 shadow-e1">
						<div className="flex items-center justify-between mb-3">
							<span className="text-[13px] text-text-muted">{t("swap.youReceiveEst")}</span>
							{quoting && <span className="w-2 h-2 rounded-full bg-sky animate-pulse" />}
						</div>
						<div className="flex items-center gap-3">
							<p className="flex-1 min-w-0 font-display text-[34px] leading-none tabular truncate text-text">
								{quote
									? formatNumber(quote.amountOutEstimated, 6)
									: quoting
										? "…"
										: "0"}
							</p>
							<div className="seg-track shrink-0">
								{tokenOptions.map((s) => (
									<button
										key={s}
										onClick={() => {
											if (s === tokenIn) flip();
											else setTokenOut(s);
										}}
										aria-pressed={tokenOut === s}
										data-active={tokenOut === s}
										className="seg-item"
									>
										{s}
									</button>
								))}
							</div>
						</div>
					</div>

					{quoteError && (
						<p role="status" aria-live="polite" className="text-glow-pink text-[13px] text-center mb-4">
							{quoteError}
						</p>
					)}

					{quote && (
						<div className="bg-surface border border-border rounded-[18px] px-5 py-4 mb-5">
							<div className="flex items-center justify-between text-[13px] mb-1.5">
								<span className="text-text-muted">{t("swap.minReceived")}</span>
								<span className="text-text tabular">
									{formatNumber(quote.minimumAmountOut, 6)} {quote.tokenOut}
								</span>
							</div>
							<div className="flex items-center justify-between text-[13px]">
								<span className="text-text-muted">{t("swap.networkFee")}</span>
								<span className="text-glow-sky">{t("swap.coveredByParmelia")}</span>
							</div>
							{quote.parmeliaFeeBps > 0 && (
								<div className="flex items-center justify-between text-[13px] mt-1.5">
									<span className="text-text-muted">{t("swap.parmeliaService", { pct: (quote.parmeliaFeeBps / 100).toFixed(2) })}</span>
									<span className="text-text tabular">
										{formatNumber(quote.parmeliaFee, 6)} {quote.tokenOut}
									</span>
								</div>
							)}
							<button
								onClick={() => setShowDetails(!showDetails)}
								className="text-[12px] text-text-faint hover:text-text-muted transition-colors mt-2.5"
							>
								{showDetails ? t("swap.hideDetails") : t("swap.showDetails")}
							</button>
							{showDetails && (
								<div className="mt-2 pt-2 border-t border-border text-[12px] text-text-faint leading-relaxed">
									<p>{t("swap.route", { route: quote.route })}</p>
									<p>{t("swap.priceTolerance", { pct: (quote.slippageBps / 100).toFixed(2) })}</p>
									<p>{t("swap.network", { network: activeNetwork.name })}</p>
								</div>
							)}
						</div>
					)}

					<div className="flex-1" />

					<button
						onClick={handleSwap}
						disabled={!quote || quoting || stage !== "idle"}
						className="btn btn-gradient btn-block"
					>
						{quoting ? t("swap.findingRoute") : t("swap.swap")}
					</button>
					<p className="text-[12px] text-text-faint text-center mt-3">
						{t("swap.confirmHint")}
					</p>
				</>
			)}
		</Screen>
	);
}

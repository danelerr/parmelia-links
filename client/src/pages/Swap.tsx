import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "../lib/firebase";
import { SERVER_URL, apiFetch } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import { humanizeError, notifyError } from "../lib/notify";
import { track } from "../lib/analytics";
import { signWithPasskey } from "../lib/webauthn";
import { hexToBytes } from "../lib/hex";
import { activeNetwork, getExplorerTxUrl } from "../lib/activeNetwork";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { useTranslation } from "react-i18next";
import Logo from "../components/Logo";

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

function StageOverlay({ stage }: { stage: SwapStage }) {
	const { t } = useTranslation();
	if (stage === "idle") return null;
	const copy: Record<Exclude<SwapStage, "idle">, string> = {
		preparing: t("swap.stagePreparing"),
		signing: t("swap.stageSigning"),
		sending: t("swap.stageSending"),
	};
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
	const [result, setResult] = useState<{ txHash: string; received: string } | null>(null);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const loadBalances = useCallback(async () => {
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/user/balance`);
			if (!res.ok) return;
			const data = await res.json();
			setBalances(data.tokens || { ETH: data.eth, USDC: data.usdc });
		} catch {
			/* non-blocking */
		}
	}, [user]);

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
		void loadBalances();
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
	}, [amount, tokenIn, tokenOut, user]);

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
			const submit = await apiFetch<{ txHash: string }>("/pay/submit", {
				user,
				body: {
					userOpHash: prep.userOpHash,
					authenticatorData: assertion.authenticatorData,
					clientDataJSON: assertion.clientDataJSON,
					r: assertion.r,
					s: assertion.s,
					credentialId: assertion.credentialId,
					qx: assertion.qx,
					qy: assertion.qy,
				},
			});

			track("swap_completed", { from: tokenIn, to: tokenOut });
			setResult({ txHash: submit.txHash, received: quote.amountOutEstimated });
			setQuote(null);
			setAmount("");
			void loadBalances();
		} catch (err) {
			notifyError(err, t("swap.swapError"));
		} finally {
			setStage("idle");
		}
	}

	const balanceIn = balances[tokenIn];
	const tokenOptions = tokens.map((t) => t.symbol);

	// ===== Success screen =====
	if (result) {
		return (
			<div className="flex flex-col min-h-dvh px-5 pt-[calc(env(safe-area-inset-top)_+_1.5rem)] pb-[calc(env(safe-area-inset-bottom)_+_2.5rem)] w-full max-w-[460px] mx-auto animate-fade-up">
				<header className="flex items-center">
					<BackButton onClick={() => navigate("/")} />
				</header>
				<div className="flex-1 flex flex-col items-center justify-center text-center">
					<div className="w-16 h-16 rounded-full bg-sky/15 flex items-center justify-center mb-6 shadow-glow-sky">
						<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9ce3f4" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
							<polyline points="20 6 9 17 4 12" />
						</svg>
					</div>
					<p className="text-[15px] text-text-muted mb-1">{t("swap.successLead")}</p>
					<p className="font-display text-[40px] leading-none tabular mb-4">
						{Number(result.received).toLocaleString("en-US", { maximumFractionDigits: 6 })}
						<span className="text-text-muted text-[20px] ml-1.5">{tokenOut}</span>
					</p>
					<p className="text-[13px] text-text-faint mb-2">{t("swap.fundsUpdated")}</p>
					<a
						href={getExplorerTxUrl(result.txHash)}
						target="_blank"
						rel="noopener noreferrer"
						className="text-text-faint text-[12px]"
					>
						{t("swap.viewOnNetwork")}
					</a>
				</div>
				<button onClick={() => setResult(null)} className="btn btn-primary btn-block">
					{t("swap.doAnother")}
				</button>
			</div>
		);
	}

	return (
		<div className="flex flex-col min-h-dvh px-5 pt-[calc(env(safe-area-inset-top)_+_1.5rem)] pb-[calc(env(safe-area-inset-bottom)_+_2.5rem)] w-full max-w-[460px] mx-auto animate-fade-up">
			<StageOverlay stage={stage} />
			<header className="flex items-center gap-3 mb-7">
				<BackButton onClick={() => navigate("/")} />
				<h1 className="text-[22px]">{t("swap.title")}</h1>
			</header>

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
									{t("swap.balanceUseAll", { balance: Number(balanceIn).toLocaleString("en-US", { maximumFractionDigits: 6 }) })}
								</button>
							)}
						</div>
						<div className="flex items-center gap-3">
							<input
								type="number"
								placeholder="0"
								value={amount}
								onChange={(e) => setAmount(e.target.value)}
								step="any"
								min="0"
								inputMode="decimal"
								autoFocus
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
									? Number(quote.amountOutEstimated).toLocaleString("en-US", { maximumFractionDigits: 6 })
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
						<p className="text-glow-pink text-[13px] text-center mb-4">{quoteError}</p>
					)}

					{quote && (
						<div className="bg-surface border border-border rounded-[18px] px-5 py-4 mb-5">
							<div className="flex items-center justify-between text-[13px] mb-1.5">
								<span className="text-text-muted">{t("swap.minReceived")}</span>
								<span className="text-text tabular">
									{Number(quote.minimumAmountOut).toLocaleString("en-US", { maximumFractionDigits: 6 })} {quote.tokenOut}
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
										{Number(quote.parmeliaFee).toLocaleString("en-US", { maximumFractionDigits: 6 })} {quote.tokenOut}
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
		</div>
	);
}

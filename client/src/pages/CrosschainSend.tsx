// Cross-chain send (Flow B outbound): send USDC from Arbitrum to another CCTP
// chain. Quote -> prepare (server builds approve+bridgeUSDC) -> exact review
// sheet -> passkey sign -> /pay/submit. The burn is accepted asynchronously; the relayer
// verifies it and completes the mint on the destination. The progress screen
// tracks the op live via GET /crosschain/status/:opId (burn -> attestation ->
// mint -> arrived) instead of relying only on the push notification.

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { User } from "../lib/firebase";
import { SERVER_URL, apiFetch } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import { humanizeError, notifyError } from "../lib/notify";
import { signWithPasskey } from "../lib/webauthn";
import { submitUserOp } from "../lib/submit";
import { userOperationChallenge, type PreparedUserOperation } from "../lib/eip712";
import { activeNetwork } from "../lib/activeNetwork";
import { getNetworkConfig, isSupportedChainKey } from "../lib/networks";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { usePasskeyGuidance } from "../hooks/usePasskeyGuidance";
import { useTranslation } from "react-i18next";
import { formatAmount, formatNumber } from "../lib/format";
import Logo from "../components/Logo";
import AmountInput from "../components/AmountInput";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import StageOverlay from "../components/StageOverlay";
import ConfirmSheet from "../components/ConfirmSheet";
import TxResult from "../components/TxResult";
import NetworkChips from "../components/NetworkChips";
import CrosschainTimeline from "../components/CrosschainTimeline";
import { FormPageSkeleton } from "../components/Skeleton";
import SigningDetails from "../components/SigningDetails";
import { useChainPortfolio, type ChainPortfolio } from "../hooks/useChainPortfolio";
import {
	InsetPanel,
	MoneyPanel,
	SummaryRow,
	TransactionActions,
} from "../components/finance/FinancialPrimitives";

type Destination = { chainId: number; name: string; domain: number };
type Mode = "fast" | "standard";
type Stage = "idle" | "preparing" | "signing" | "sending";

type Quote = {
	amountIn: string;
	gatoPagoFee: string;
	cctpFeeEstimated: string;
	amountOutEstimated: string;
	estimatedMinutes: number;
	mode: Mode;
};

type QuoteState = {
	key: string;
	quote: Quote | null;
	error: string;
	loading: boolean;
};

type PreparedCrosschain = PreparedUserOperation & {
	opId?: string;
	sourceChainKey: string;
	sourceChainId: number;
	summary: {
		token: "USDC";
		amountIn: string;
		amountOutEstimated: string;
		gatoPagoFee: string;
		cctpFeeEstimated: string;
		destinationChainId: number;
		destinationName: string;
		recipient: string;
		mode: Mode;
		estimatedMinutes: number;
	};
};

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Tx explorers for supported CCTP destinations (the mint lands there). */
const DEST_EXPLORERS: Record<number, string> = {
	421614: "https://sepolia.arbiscan.io",
	42161: "https://arbiscan.io",
	84532: "https://sepolia.basescan.org",
	8453: "https://basescan.org",
	43113: "https://testnet.snowtrace.io",
};

type OpStatus = {
	status: string;
	destinationTxHash: string | null;
	destinationChainId: number;
};

/** In-flight statuses keep polling; anything else is settled or manual-land. */
const IN_FLIGHT_STATUSES = new Set(["quoted", "pending_signature", "submitted", "waiting_attestation", "minting", "recoverable"]);
const TRACK_FAST_INTERVAL_MS = 5_000;
const TRACK_SLOW_INTERVAL_MS = 15_000;
const TRACK_FAST_WINDOW_MS = 2 * 60_000;
const TRACK_MAX_DURATION_MS = 30 * 60_000;

async function fetchSourceUsdcBalance(
	user: User,
	chainKey: string,
	fresh = false,
): Promise<string | null> {
	try {
		const query = new URLSearchParams({ chainKey });
		if (fresh) query.set("fresh", "1");
		const res = await fetchWithAuth(
			user,
			`${SERVER_URL}/user/balance?${query.toString()}`,
		);
		if (!res.ok) return null;
		const data = await res.json() as { tokens?: { USDC?: string }; usdc?: string };
		return data.tokens?.USDC ?? data.usdc ?? null;
	} catch {
		return null;
	}
}

export default function CrosschainSend({
	user,
	previewPortfolio,
}: {
	user: User;
	previewPortfolio?: ChainPortfolio;
}) {
	const navigate = useViewTransitionNavigate();
	const guideToPasskeys = usePasskeyGuidance();
	const [searchParams] = useSearchParams();
	const { t } = useTranslation();
	const { data: portfolio, error: portfolioError } = useChainPortfolio(user, previewPortfolio);
	const recipientParam = searchParams.get("recipient") ?? "";
	const requestedChainId = Number(searchParams.get("chainId"));
	const requestedSourceKey = searchParams.get("sourceChainKey");
	const explicitSourceKey = requestedSourceKey && isSupportedChainKey(requestedSourceKey)
		? requestedSourceKey
		: null;
	const hasExplicitSourceRequest = requestedSourceKey !== null;
	const cameFromQr = searchParams.get("source") === "qr";
	const [sourceChainKey, setSourceChainKey] = useState(
		requestedSourceKey ?? activeNetwork.key,
	);
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [configSourceKey, setConfigSourceKey] = useState<string | null>(null);
	const [fastSupported, setFastSupported] = useState(true);
	const [destinations, setDestinations] = useState<Destination[]>([]);
	const [destChainId, setDestChainId] = useState<number | null>(null);
	const [recipient, setRecipient] = useState(
		ADDRESS_RE.test(recipientParam) ? recipientParam : "",
	);
	const [amount, setAmount] = useState("");
	const [mode, setMode] = useState<Mode>("fast");
	const [balance, setBalance] = useState<string | undefined>(undefined);
	const [quoteState, setQuoteState] = useState<QuoteState>({
		key: "",
		quote: null,
		error: "",
		loading: false,
	});
	const [stage, setStage] = useState<Stage>("idle");
	const [confirming, setConfirming] = useState(false);
	const [prepared, setPrepared] = useState<PreparedCrosschain | null>(null);
	const [result, setResult] = useState<{ txHash: string | null; received: string; minutes: number; opId: string | null } | null>(null);
	const [opStatus, setOpStatus] = useState<OpStatus | null>(null);
	const [trackingEnded, setTrackingEnded] = useState(false);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Monotonic id per quote request: responses from an outdated request (older
	// amount/network/mode) are dropped so a stale quote can never enable Send.
	const quoteSeqRef = useRef(0);
	const sourceAccounts = portfolio?.chains.filter((chain) =>
		chain.walletRailEnabled &&
		chain.rpcConfigured &&
		chain.account?.status === "active" &&
		chain.account.securityStatus === "current" &&
		chain.account.securityVersionApplied === chain.account.securityVersionDesired &&
		chain.balance.assets.some((asset) => asset.symbol === "USDC"),
	) ?? [];
	const effectiveSource = sourceAccounts.find((chain) => chain.key === sourceChainKey)
		?? (hasExplicitSourceRequest
			? null
			: sourceAccounts.find((chain) => chain.key === activeNetwork.key) ?? sourceAccounts[0])
		?? null;
	const effectiveSourceKey = effectiveSource?.key ?? explicitSourceKey ?? activeNetwork.key;
	const effectiveSourceNetwork = getNetworkConfig(effectiveSourceKey);
	const effectiveSourceName = explicitSourceKey
		? effectiveSourceNetwork.name
		: hasExplicitSourceRequest
			? requestedSourceKey
			: effectiveSourceNetwork.name;
	const ownDestination = portfolio?.chains.find((chain) =>
		chain.chainId === destChainId &&
		chain.account?.status === "active" &&
		chain.account.securityStatus === "current" &&
		chain.account.securityVersionApplied === chain.account.securityVersionDesired,
	) ?? null;
	const routeEnabled = portfolioError || (portfolio && !effectiveSource)
		? false
		: effectiveSource && configSourceKey === effectiveSourceKey
			? enabled
			: null;

	useEffect(() => {
		if (!portfolio || !effectiveSource) return;
		let cancelled = false;
		(async () => {
			try {
				const res = await fetchWithAuth(
					user,
					`${SERVER_URL}/crosschain/config?sourceChainKey=${encodeURIComponent(effectiveSourceKey)}`,
				);
				if (!res.ok) throw new Error();
				const data = await res.json();
				if (cancelled) return;
				setConfigSourceKey(effectiveSourceKey);
				setEnabled(!!data.enabled);
				setFastSupported(data.fastSupported !== false);
				if (data.fastSupported === false) setMode("standard");
				const available = Array.isArray(data.destinations) ? data.destinations : [];
				setDestinations(available);
				if (available.length) {
					setDestChainId(
						available.some((destination: Destination) => destination.chainId === requestedChainId)
							? requestedChainId
							: available[0].chainId,
					);
				}
			} catch {
				if (cancelled) return;
				setConfigSourceKey(effectiveSourceKey);
				setEnabled(false);
			}
		})();
		queueMicrotask(() => {
			void fetchSourceUsdcBalance(user, effectiveSourceKey, true).then((next) => {
				if (!cancelled && next !== null) setBalance(next);
			});
		});
		return () => { cancelled = true; };
	}, [effectiveSource, effectiveSourceKey, portfolio, portfolioError, user, requestedChainId]);

	const amountNumber = Number(amount);
	const quoteKey =
			routeEnabled &&
		destChainId &&
		amount &&
		Number.isFinite(amountNumber) &&
		amountNumber > 0
			? `${effectiveSourceKey}:${amount}:${destChainId}:${mode}`
			: null;
	const quote = quoteKey && quoteState.key === quoteKey ? quoteState.quote : null;
	const quoteError = quoteKey && quoteState.key === quoteKey ? quoteState.error : "";
	const quoting = Boolean(quoteKey) && (quoteState.key !== quoteKey || quoteState.loading);

	// Debounced quoting.
	useEffect(() => {
		const seq = ++quoteSeqRef.current;
		if (debounceRef.current) clearTimeout(debounceRef.current);
		if (!quoteKey || !destChainId) return;

		debounceRef.current = setTimeout(async () => {
			setQuoteState({ key: quoteKey, quote: null, error: "", loading: true });
			try {
				const data = await apiFetch<Quote>("/crosschain/quote", {
					user,
					body: { sourceChainKey: effectiveSourceKey, amount, destinationChainId: destChainId, mode },
				});
				if (seq !== quoteSeqRef.current) return; // stale response - ignore
				setQuoteState({ key: quoteKey, quote: data, error: "", loading: false });
			} catch (err) {
				if (seq !== quoteSeqRef.current) return;
				setQuoteState({
					key: quoteKey,
					quote: null,
					error: humanizeError(err, t("crosschain.quoteError")).message,
					loading: false,
				});
			}
		}, 450);

		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [amount, destChainId, effectiveSourceKey, mode, quoteKey, user, t]);

	// Live tracking of the op after the burn confirms: burn -> attestation ->
	// mint -> arrived. Poll quickly while Fast transfers normally advance, then
	// reduce frequency and keep the timeline alive long enough for Standard CCTP.
	useEffect(() => {
		if (!result?.opId) return;
		const startedAt = Date.now();
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const pollStatus = async () => {
			if (stopped) return;
			try {
				const data = await apiFetch<OpStatus>(`/crosschain/status/${result.opId}`, { user });
				if (stopped) return;
				setOpStatus(data);
				if (!IN_FLIGHT_STATUSES.has(data.status)) {
					stopped = true;
					setTrackingEnded(true);
				}
			} catch {
				/* transient; keep polling until the cap */
			}
			const elapsed = Date.now() - startedAt;
			if (elapsed >= TRACK_MAX_DURATION_MS && !stopped) {
				stopped = true;
				setTrackingEnded(true);
			}
			if (!stopped) {
				const delay = elapsed < TRACK_FAST_WINDOW_MS
					? TRACK_FAST_INTERVAL_MS
					: TRACK_SLOW_INTERVAL_MS;
				timer = setTimeout(() => void pollStatus(), delay);
			}
		};
		void pollStatus();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}, [result, user]);

	const recipientValid = ADDRESS_RE.test(recipient.trim());
	const canSend = !!effectiveSource && !!quote && recipientValid && stage === "idle" && !quoting;
	const destName = destinations.find((d) => d.chainId === destChainId)?.name ?? "";
	const totalFees = prepared
		? Number(prepared.summary.gatoPagoFee) + Number(prepared.summary.cctpFeeEstimated)
		: 0;

	const stageCopy: Record<Exclude<Stage, "idle">, string> = {
		preparing: t("crosschain.stagePreparing"),
		signing: t("crosschain.stageSigning"),
		sending: t("crosschain.stageSending"),
	};

	async function prepareForReview() {
		if (!quote || !destChainId || !recipientValid) return;
		setStage("preparing");
		try {
			const prep = await apiFetch<PreparedCrosschain>(
				"/crosschain/prepare",
				{ user, body: { sourceChainKey: effectiveSourceKey, amount, destinationChainId: destChainId, recipient: recipient.trim(), mode } },
			);
			userOperationChallenge(prep, prep.sourceChainId);
			setPrepared(prep);
			setConfirming(true);
		} catch (err) {
			notifyError(err, t("crosschain.sendError"));
		} finally {
			setStage("idle");
		}
	}

	async function confirmAndSend() {
		const prep = prepared;
		if (!prep) return;
		setConfirming(false);
		try {
			setStage("signing");
			const assertion = await signWithPasskey(
				userOperationChallenge(prep, prep.sourceChainId),
				prep.credentialId,
				prep.rpId,
			);

			setStage("sending");
			// An in-flight outcome (202/duplicate) is fine here: the op tracker below
			// polls /crosschain/status and reports the burn confirmation either way.
			const submit = await submitUserOp(user, prep.userOpHash, assertion);

			setResult({
				txHash: submit.txHash,
				received: prep.summary.amountOutEstimated,
				minutes: prep.summary.estimatedMinutes,
				opId: prep.opId ?? null,
			});
			setOpStatus(null);
			setTrackingEnded(false);
			setAmount("");
			void fetchSourceUsdcBalance(user, effectiveSourceKey, true).then((next) => {
				if (next !== null) setBalance(next);
			});
		} catch (err) {
			if (!guideToPasskeys(err, prep.credentialId)) {
				notifyError(err, t("crosschain.sendError"));
			}
		} finally {
			setStage("idle");
			setPrepared(null);
		}
	}

	// ===== Success screen (with live tracking) =====
	if (result) {
		const arrived = opStatus?.status === "completed";
		const opFailed = ["failed", "expired", "needs_support"].includes(opStatus?.status ?? "");
		const delayed = trackingEnded && !arrived && !opFailed;
		const destExplorer =
			arrived && opStatus?.destinationTxHash && DEST_EXPLORERS[opStatus.destinationChainId]
				? `${DEST_EXPLORERS[opStatus.destinationChainId]}/tx/${opStatus.destinationTxHash}`
				: null;
		const trackLabel = arrived
			? t("crosschain.trackArrived", { network: destName })
			: opFailed
				? t("crosschain.trackFailed")
				: opStatus?.status === "recoverable"
					? t("crosschain.trackRetrying")
				: delayed
					? t("crosschain.trackDelayed")
					: opStatus?.status === "minting"
						? t("crosschain.trackDelivering", { network: destName })
						: t("crosschain.trackConfirming");
		return (
			<Screen>
				<BackHeader onClick={() => navigate("/", { replace: true })} className="" />
				<TxResult
					state={opFailed ? "failed" : arrived ? "success" : "progress"}
					lead={arrived ? t("crosschain.trackArrivedLead") : t("crosschain.successLead", { network: destName })}
					amount={formatNumber(result.received, 6)}
					unit="USDC"
					body={result.opId ? trackLabel : t("crosschain.successEta", { minutes: result.minutes })}
					bodyClassName={`text-[13px] mb-2 ${arrived ? "text-growth" : opFailed ? "text-danger" : "text-text-faint"}`}
				>
					<div className="w-full mt-5 mb-5">
						<CrosschainTimeline
							status={opStatus?.status ?? null}
							destinationName={destName}
							delayed={delayed}
						/>
					</div>
					<div className="flex flex-col items-center gap-2 mb-4">
						{result.txHash && (
							<a
								href={`${effectiveSourceNetwork.explorerBaseUrl}/tx/${result.txHash}`}
								target="_blank"
								rel="noopener noreferrer"
								className="text-text-faint text-[12px]"
							>
								{t("crosschain.viewOnNetwork")}
							</a>
						)}
						{destExplorer && (
							<a
								href={destExplorer}
								target="_blank"
								rel="noopener noreferrer"
								className="text-text-faint text-[12px]"
							>
								{t("crosschain.viewOnDestination", { network: destName })}
							</a>
						)}
					</div>
				</TxResult>
				<button onClick={() => setResult(null)} className="btn btn-primary btn-block">
					{t("crosschain.doAnother")}
				</button>
			</Screen>
		);
	}

	return (
		<Screen>
			<StageOverlay label={stage === "idle" ? null : stageCopy[stage]} spinner={stage !== "signing"} />
			{confirming && prepared && (
				<ConfirmSheet
					title={t("crosschain.confirmTitle")}
					amountLabel={t("crosschain.youSend")}
					amount={formatNumber(prepared.summary.amountIn, 6)}
					unit="USDC"
					warning={t("crosschain.confirmWarning")}
					confirmLabel={t("crosschain.confirmAndSend")}
					onConfirm={() => void confirmAndSend()}
					onCancel={() => {
						setConfirming(false);
						setPrepared(null);
					}}
				>
					<p className="mb-3 text-center text-[11px] uppercase tracking-wider text-info">
						{t("crosschain.signingPreview")}
					</p>
					<InsetPanel className="mb-3">
						<SummaryRow label={t("crosschain.toNetwork")} value={prepared.summary.destinationName} />
						<SummaryRow label={t("crosschain.recipient")} value={prepared.summary.recipient} valueClassName="font-mono break-all" />
						<SummaryRow label={t("crosschain.actionsToSign")} value={t("crosschain.approveAndBridge")} />
						<SummaryRow label={t("crosschain.totalFees")} value={totalFees > 0 ? `${formatNumber(totalFees, 6)} USDC` : t("crosschain.free")} />
						<SummaryRow label={t("crosschain.youReceiveApprox")} value={`${formatNumber(prepared.summary.amountOutEstimated, 6)} USDC`} />
						<SummaryRow label={t("crosschain.estTime")} value={t("crosschain.minutes", { minutes: prepared.summary.estimatedMinutes })} />
					</InsetPanel>
					<SigningDetails payload={prepared.signingPayload} networkName={getNetworkConfig(prepared.sourceChainKey).name} />
				</ConfirmSheet>
			)}
			<BackHeader title={t("crosschain.title")} />

				{routeEnabled === null ? (
					<FormPageSkeleton />
				) : !routeEnabled ? (
				<div className="flex-1 flex flex-col items-center justify-center text-center px-6">
					<Logo className="w-12 mb-5 opacity-40" />
					<p className="text-[15px] text-text mb-1">{t("crosschain.disabledTitle")}</p>
					<p className="text-[13px] text-text-muted max-w-[280px] leading-relaxed">
						{t("crosschain.disabledBody", { network: effectiveSourceName })}
					</p>
				</div>
			) : (
				<>
					{sourceAccounts.length > 1 ? (
						<>
							<p className="text-[13px] text-text-muted px-1 mb-2">{t("crosschain.fromNetwork")}</p>
							<NetworkChips
								options={sourceAccounts.map((chain) => ({ id: chain.chainId, label: chain.name }))}
								selected={effectiveSource?.chainId ?? null}
								onSelect={(chainId) => {
									const next = sourceAccounts.find((chain) => chain.chainId === chainId);
									if (!next || !isSupportedChainKey(next.key)) return;
									setSourceChainKey(next.key);
									setMode(next.chainId === 43113 ? "standard" : "fast");
								}}
							/>
						</>
					) : null}
					{/* Destination network */}
					<p className="text-[13px] text-text-muted px-1 mb-2">{t("crosschain.toNetwork")}</p>
					<NetworkChips
						options={destinations.map((d) => ({ id: d.chainId, label: d.name }))}
						selected={destChainId}
						onSelect={setDestChainId}
					/>

					{/* Recipient */}
					<div className="flex items-center justify-between gap-3 px-1 mb-2">
						<p className="text-[13px] text-text-muted">{t("crosschain.recipient")}</p>
						{cameFromQr ? (
							<span className="meli-chip text-text-faint">
								{t("crosschain.fromQr")}
							</span>
						) : null}
					</div>
					<input
						type="text"
						name="recipient"
						autoComplete="off"
						aria-label={t("crosschain.recipient")}
						placeholder="0x…"
						value={recipient}
						onChange={(e) => setRecipient(e.target.value)}
						spellCheck={false}
						autoCapitalize="off"
						className="meli-field mb-1 h-12 font-mono text-[14px] placeholder:text-text-faint"
					/>
					{ownDestination?.account ? (
						<button
							type="button"
							onClick={() => setRecipient(ownDestination.account!.walletAddress)}
							className="mb-3 mt-2 text-[12px] text-info underline underline-offset-4"
						>
							{t("crosschain.useOwnAccount", { network: ownDestination.name })}
						</button>
					) : null}
					{recipient.length > 0 && !recipientValid && (
						<p role="status" aria-live="polite" className="mb-3 px-1 text-[12px] text-danger">
							{t("crosschain.invalidAddress")}
						</p>
					)}

					{/* Amount */}
					<MoneyPanel className="mt-4 mb-5">
						<div className="flex items-center justify-between mb-3">
							<span className="text-[13px] text-text-muted">{t("crosschain.youSend")}</span>
							{balance !== undefined && (
								<button
									onClick={() => setAmount(balance)}
									className="text-[12px] text-text-faint"
								>
									{t("crosschain.balanceUseAll", { balance: formatAmount(balance, "USDC") })}
								</button>
							)}
						</div>
						<div className="flex items-center gap-3">
							<AmountInput
								name="amount"
								aria-label={t("crosschain.youSend")}
								placeholder="0"
								value={amount}
								onChange={setAmount}
								className="flex-1 min-w-0 bg-transparent font-display text-[34px] leading-none text-text placeholder:text-text-faint tabular"
							/>
							<span className="text-[15px] text-text-muted font-medium shrink-0">USDC</span>
						</div>
					</MoneyPanel>

					{/* Speed mode */}
					{fastSupported ? <div className="seg-track seg-track-block mb-2">
						{(
							[
								["fast", t("crosschain.fast")],
								["standard", t("crosschain.economic")],
							] as const
						).map(([value, label]) => (
							<button
								key={value}
								onClick={() => setMode(value)}
								aria-pressed={mode === value}
								data-active={mode === value}
								className="seg-item"
							>
								{label}
							</button>
						))}
					</div> : null}
					<p className="text-[12px] text-text-faint px-1 mb-5 leading-relaxed">
						{fastSupported
							? mode === "fast" ? t("crosschain.modeHintFast") : t("crosschain.modeHintStandard")
							: t("crosschain.avalancheStandard")}
					</p>

					{quoteError && (
						<p role="status" aria-live="polite" className="mb-4 text-center text-[13px] text-danger">
							{quoteError}
						</p>
					)}
					{quoting && (
						<p role="status" aria-live="polite" className="text-[13px] text-text-muted text-center mb-4 animate-pulse-soft">
							{t("crosschain.quoting")}
						</p>
					)}

					{quote && (
						<InsetPanel className="mb-5">
							<SummaryRow label={t("crosschain.youReceiveApprox")} value={`${formatNumber(quote.amountOutEstimated, 6)} USDC`} valueClassName="font-medium" />
							{Number(quote.gatoPagoFee) > 0 && (
								<SummaryRow label={t("crosschain.gatoPagoFee")} value={`${quote.gatoPagoFee} USDC`} />
							)}
							<SummaryRow label={t("crosschain.bridgeCost")} value={Number(quote.cctpFeeEstimated) > 0 ? `${formatNumber(quote.cctpFeeEstimated, 6)} USDC` : t("crosschain.free")} />
							<SummaryRow label={t("crosschain.networkFee")} value={t("crosschain.coveredByGatoPago")} valueClassName="text-growth" />
							<SummaryRow label={t("crosschain.estTime")} value={t("crosschain.minutes", { minutes: quote.estimatedMinutes })} />
						</InsetPanel>
					)}

					<TransactionActions hint={t("crosschain.confirmHint")}>
						<button onClick={() => void prepareForReview()} disabled={!canSend} className="btn btn-primary btn-block">
							{t("crosschain.send")}
						</button>
					</TransactionActions>
				</>
			)}
		</Screen>
	);
}

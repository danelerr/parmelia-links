// Cross-chain send (Flow B outbound): send USDC from Arbitrum to another CCTP
// chain. Quote -> review sheet -> prepare (server builds approve+bridgeUSDC) ->
// passkey sign -> /pay/submit. The burn is accepted asynchronously; the relayer
// verifies it and completes the mint on the destination. The progress screen
// tracks the op live via GET /crosschain/status/:opId (burn -> attestation ->
// mint -> arrived) instead of relying only on the push notification.

import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "../lib/firebase";
import { SERVER_URL, apiFetch } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import { humanizeError, notifyError } from "../lib/notify";
import { signWithPasskey } from "../lib/webauthn";
import { submitUserOp } from "../lib/submit";
import { hexToBytes } from "../lib/hex";
import { activeNetwork, getExplorerTxUrl } from "../lib/activeNetwork";
import { useViewTransitionNavigate } from "../hooks/useNav";
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
import { Spinner } from "../components/icons";

type Destination = { chainId: number; name: string; domain: number };
type Mode = "fast" | "standard";
type Stage = "idle" | "preparing" | "signing" | "sending";

type Quote = {
	amountIn: string;
	parmeliaFee: string;
	cctpFeeEstimated: string;
	amountOutEstimated: string;
	estimatedMinutes: number;
	mode: Mode;
};

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

/** Tx explorers for supported CCTP destinations (the mint lands there). */
const DEST_EXPLORERS: Record<number, string> = {
	421614: "https://sepolia.arbiscan.io",
	42161: "https://arbiscan.io",
	84532: "https://sepolia.basescan.org",
	8453: "https://basescan.org",
};

type OpStatus = {
	status: string;
	destinationTxHash: string | null;
	destinationChainId: number;
};

/** In-flight statuses keep polling; anything else is settled or manual-land. */
const IN_FLIGHT_STATUSES = new Set(["quoted", "submitted", "waiting_attestation", "minting"]);
const TRACK_INTERVAL_MS = 5000;
const TRACK_MAX_POLLS = 60; // ~5 min; after that we stop and reassure

export default function CrosschainSend({ user }: { user: User }) {
	const navigate = useViewTransitionNavigate();
	const { t } = useTranslation();
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [destinations, setDestinations] = useState<Destination[]>([]);
	const [destChainId, setDestChainId] = useState<number | null>(null);
	const [recipient, setRecipient] = useState("");
	const [amount, setAmount] = useState("");
	const [mode, setMode] = useState<Mode>("fast");
	const [balance, setBalance] = useState<string | undefined>(undefined);
	const [quote, setQuote] = useState<Quote | null>(null);
	const [quoting, setQuoting] = useState(false);
	const [quoteError, setQuoteError] = useState("");
	const [stage, setStage] = useState<Stage>("idle");
	const [confirming, setConfirming] = useState(false);
	const [result, setResult] = useState<{ txHash: string | null; received: string; minutes: number; opId: string | null } | null>(null);
	const [opStatus, setOpStatus] = useState<OpStatus | null>(null);
	const [trackingEnded, setTrackingEnded] = useState(false);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// Monotonic id per quote request: responses from an outdated request (older
	// amount/network/mode) are dropped so a stale quote can never enable Send.
	const quoteSeqRef = useRef(0);

	const loadBalance = useCallback(async (fresh = false) => {
		try {
			const res = await fetchWithAuth(
				user,
				`${SERVER_URL}/user/balance${fresh ? "?fresh=1" : ""}`,
			);
			if (!res.ok) return;
			const data = await res.json();
			setBalance((data.tokens && data.tokens.USDC) ?? data.usdc);
		} catch {
			/* non-blocking */
		}
	}, [user]);

	useEffect(() => {
		(async () => {
			try {
				const res = await fetchWithAuth(user, `${SERVER_URL}/crosschain/config`);
				if (!res.ok) throw new Error();
				const data = await res.json();
				setEnabled(!!data.enabled);
				setDestinations(data.destinations || []);
				if (data.destinations?.length) setDestChainId(data.destinations[0].chainId);
			} catch {
				setEnabled(false);
			}
		})();
		void loadBalance(true);
	}, [user, loadBalance]);

	// Debounced quoting.
	useEffect(() => {
		setQuote(null);
		setQuoteError("");
		const seq = ++quoteSeqRef.current;
		if (debounceRef.current) clearTimeout(debounceRef.current);
		const value = Number(amount);
		if (!enabled || !destChainId || !amount || !Number.isFinite(value) || value <= 0) return;

		debounceRef.current = setTimeout(async () => {
			setQuoting(true);
			try {
				const data = await apiFetch<Quote>("/crosschain/quote", {
					user,
					body: { amount, destinationChainId: destChainId, mode },
				});
				if (seq !== quoteSeqRef.current) return; // stale response - ignore
				setQuote(data);
			} catch (err) {
				if (seq !== quoteSeqRef.current) return;
				setQuoteError(humanizeError(err, t("crosschain.quoteError")).message);
			} finally {
				if (seq === quoteSeqRef.current) setQuoting(false);
			}
		}, 450);

		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [amount, destChainId, mode, enabled, user, t]);

	// Live tracking of the op after the burn confirms: burn -> attestation ->
	// mint -> arrived. Stops on a settled status or after ~5 min (then the push
	// notification takes over; the money is safe either way — see design I1).
	useEffect(() => {
		if (!result?.opId) return;
		let polls = 0;
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const pollStatus = async () => {
			if (stopped) return;
			polls++;
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
			if (polls >= TRACK_MAX_POLLS && !stopped) {
				stopped = true;
				setTrackingEnded(true);
			}
			if (!stopped) {
				timer = setTimeout(() => void pollStatus(), TRACK_INTERVAL_MS);
			}
		};
		void pollStatus();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}, [result, user]);

	const recipientValid = ADDRESS_RE.test(recipient.trim());
	const canSend = !!quote && recipientValid && stage === "idle" && !quoting;
	const destName = destinations.find((d) => d.chainId === destChainId)?.name ?? "";
	const totalFees = quote ? Number(quote.parmeliaFee) + Number(quote.cctpFeeEstimated) : 0;

	const stageCopy: Record<Exclude<Stage, "idle">, string> = {
		preparing: t("crosschain.stagePreparing"),
		signing: t("crosschain.stageSigning"),
		sending: t("crosschain.stageSending"),
	};

	async function handleSend() {
		if (!quote || !destChainId || !recipientValid) return;
		setStage("preparing");
		try {
			const prep = await apiFetch<{ userOpHash: string; opId?: string; credentialId: string | null; summary: { amountOutEstimated: string; estimatedMinutes: number } }>(
				"/crosschain/prepare",
				{ user, body: { amount, destinationChainId: destChainId, recipient: recipient.trim(), mode } },
			);

			setStage("signing");
			const assertion = await signWithPasskey(
				hexToBytes(prep.userOpHash as `0x${string}`),
				prep.credentialId,
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
			setQuote(null);
			setAmount("");
			void loadBalance(true);
		} catch (err) {
			notifyError(err, t("crosschain.sendError"));
		} finally {
			setStage("idle");
		}
	}

	// The gradient CTA only OPENS the review sheet; prepare+sign+submit run only
	// after an explicit confirmation (cross-chain sends are irreversible).
	function confirmAndSend() {
		setConfirming(false);
		void handleSend();
	}

	// ===== Success screen (with live tracking) =====
	if (result) {
		const arrived = opStatus?.status === "completed";
		const opFailed = opStatus?.status === "failed";
		const delayed = trackingEnded && !arrived && !opFailed;
		const destExplorer =
			arrived && opStatus?.destinationTxHash && DEST_EXPLORERS[opStatus.destinationChainId]
				? `${DEST_EXPLORERS[opStatus.destinationChainId]}/tx/${opStatus.destinationTxHash}`
				: null;
		const trackLabel = arrived
			? t("crosschain.trackArrived", { network: destName })
			: opFailed
				? t("crosschain.trackFailed")
				: delayed
					? t("crosschain.trackDelayed")
					: opStatus?.status === "minting"
						? t("crosschain.trackDelivering", { network: destName })
						: t("crosschain.trackConfirming");
		return (
			<Screen>
				<BackHeader onClick={() => navigate("/")} className="" />
				<TxResult
					state={opFailed ? "failed" : arrived ? "success" : "progress"}
					lead={arrived ? t("crosschain.trackArrivedLead") : t("crosschain.successLead", { network: destName })}
					amount={formatNumber(result.received, 6)}
					unit="USDC"
					body={result.opId ? trackLabel : t("crosschain.successEta", { minutes: result.minutes })}
					bodyClassName={`text-[13px] mb-2 ${arrived ? "text-glow-sky" : opFailed ? "text-glow-pink" : "text-text-faint"} ${!arrived && !delayed && !opFailed && result.opId ? "animate-pulse-soft" : ""}`}
				>
					<div className="flex flex-col items-center gap-1">
						{result.txHash && (
							<a
								href={getExplorerTxUrl(result.txHash)}
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
			{confirming && quote && (
				<ConfirmSheet
					title={t("crosschain.confirmTitle")}
					amountLabel={t("crosschain.youSend")}
					amount={formatNumber(quote.amountIn, 6)}
					unit="USDC"
					warning={t("crosschain.confirmWarning")}
					confirmLabel={t("crosschain.confirmAndSend")}
					onConfirm={confirmAndSend}
					onCancel={() => setConfirming(false)}
				>
					<div className="bg-bg border border-border rounded-[14px] px-4 py-3 mb-3">
						<span className="text-[12px] text-text-muted block mb-1">{t("crosschain.toNetwork")}</span>
						<span className="text-[15px] text-text">{destName}</span>
					</div>
					<div className="bg-bg border border-border rounded-[14px] px-4 py-3 mb-3">
						<span className="text-[12px] text-text-muted block mb-1">{t("crosschain.recipient")}</span>
						<span className="text-[13px] text-text font-mono break-all">{recipient.trim()}</span>
					</div>
					<div className="bg-bg border border-border rounded-[14px] px-4 py-3 mb-3 flex flex-col gap-1.5">
						<div className="flex items-center justify-between text-[13px]">
							<span className="text-text-muted">{t("crosschain.totalFees")}</span>
							<span className="text-text tabular">
								{totalFees > 0 ? `${formatNumber(totalFees, 6)} USDC` : t("crosschain.free")}
							</span>
						</div>
						<div className="flex items-center justify-between text-[13px]">
							<span className="text-text-muted">{t("crosschain.youReceiveApprox")}</span>
							<span className="text-text tabular">{formatNumber(quote.amountOutEstimated, 6)} USDC</span>
						</div>
						<div className="flex items-center justify-between text-[13px]">
							<span className="text-text-muted">{t("crosschain.estTime")}</span>
							<span className="text-text">{t("crosschain.minutes", { minutes: quote.estimatedMinutes })}</span>
						</div>
					</div>
				</ConfirmSheet>
			)}
			<BackHeader onClick={() => navigate("/")} title={t("crosschain.title")} />

			{enabled === null ? (
				<div className="flex-1 flex items-center justify-center">
					<Spinner />
				</div>
			) : !enabled ? (
				<div className="flex-1 flex flex-col items-center justify-center text-center px-6">
					<Logo className="w-12 mb-5 opacity-40" />
					<p className="text-[15px] text-text mb-1">{t("crosschain.disabledTitle")}</p>
					<p className="text-[13px] text-text-muted max-w-[280px] leading-relaxed">
						{t("crosschain.disabledBody", { network: activeNetwork.name })}
					</p>
				</div>
			) : (
				<>
					{/* Destination network */}
					<p className="text-[13px] text-text-muted px-1 mb-2">{t("crosschain.toNetwork")}</p>
					<NetworkChips
						options={destinations.map((d) => ({ id: d.chainId, label: d.name }))}
						selected={destChainId}
						onSelect={setDestChainId}
					/>

					{/* Recipient */}
					<p className="text-[13px] text-text-muted px-1 mb-2">{t("crosschain.recipient")}</p>
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
						className="w-full bg-surface border border-border rounded-[14px] h-12 px-4 text-[14px] text-text placeholder:text-text-faint font-mono focus:border-border-strong transition-colors mb-1"
					/>
					{recipient.length > 0 && !recipientValid && (
						<p role="status" aria-live="polite" className="text-glow-pink text-[12px] px-1 mb-3">
							{t("crosschain.invalidAddress")}
						</p>
					)}

					{/* Amount */}
					<div className="bg-surface border border-border rounded-[18px] p-5 mt-4 mb-5 shadow-e1">
						<div className="flex items-center justify-between mb-3">
							<span className="text-[13px] text-text-muted">{t("crosschain.youSend")}</span>
							{balance !== undefined && (
								<button
									onClick={() => setAmount(balance)}
									className="text-[12px] text-text-faint hover:text-text-muted transition-colors"
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
					</div>

					{/* Speed mode */}
					<div className="seg-track seg-track-block mb-2">
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
					</div>
					<p className="text-[12px] text-text-faint px-1 mb-5 leading-relaxed">
						{mode === "fast" ? t("crosschain.modeHintFast") : t("crosschain.modeHintStandard")}
					</p>

					{quoteError && (
						<p role="status" aria-live="polite" className="text-glow-pink text-[13px] text-center mb-4">
							{quoteError}
						</p>
					)}
					{quoting && (
						<p role="status" aria-live="polite" className="text-[13px] text-text-muted text-center mb-4 animate-pulse-soft">
							{t("crosschain.quoting")}
						</p>
					)}

					{quote && (
						<div className="bg-surface border border-border rounded-[18px] px-5 py-4 mb-5">
							<div className="flex items-center justify-between text-[14px] mb-2">
								<span className="text-text-muted">{t("crosschain.youReceiveApprox")}</span>
								<span className="text-text font-medium tabular">
									{formatNumber(quote.amountOutEstimated, 6)} USDC
								</span>
							</div>
							{Number(quote.parmeliaFee) > 0 && (
								<div className="flex items-center justify-between text-[13px] mb-1.5">
									<span className="text-text-muted">{t("crosschain.parmeliaFee")}</span>
									<span className="text-text tabular">{quote.parmeliaFee} USDC</span>
								</div>
							)}
							<div className="flex items-center justify-between text-[13px] mb-1.5">
								<span className="text-text-muted">{t("crosschain.bridgeCost")}</span>
								<span className="text-text tabular">
									{Number(quote.cctpFeeEstimated) > 0
										? `${formatNumber(quote.cctpFeeEstimated, 6)} USDC`
										: t("crosschain.free")}
								</span>
							</div>
							<div className="flex items-center justify-between text-[13px]">
								<span className="text-text-muted">{t("crosschain.networkFee")}</span>
								<span className="text-glow-sky">{t("crosschain.coveredByParmelia")}</span>
							</div>
							<div className="flex items-center justify-between text-[13px] mt-1.5">
								<span className="text-text-muted">{t("crosschain.estTime")}</span>
								<span className="text-text">{t("crosschain.minutes", { minutes: quote.estimatedMinutes })}</span>
							</div>
						</div>
					)}

					<div className="flex-1" />

					<button onClick={() => setConfirming(true)} disabled={!canSend} className="btn btn-gradient btn-block">
						{t("crosschain.send")}
					</button>
					<p className="text-[12px] text-text-faint text-center mt-3 leading-relaxed">{t("crosschain.confirmHint")}</p>
				</>
			)}
		</Screen>
	);
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatUnits } from "viem";
import { useTranslation } from "react-i18next";
import ConfirmSheet from "../../components/ConfirmSheet";
import {
	InsetPanel,
	SectionLabel,
	SummaryRow,
	TransactionActions,
} from "../../components/finance/FinancialPrimitives";
import { ApiError } from "../../lib/api";
import { formatAmount } from "../../lib/format";
import {
	cancelCheckoutAttempt,
	createCheckoutAttempt,
	createCheckoutQuote,
	getCheckoutAttempt,
	registerCheckoutTransaction,
} from "./api";
import {
	CheckoutExecutionError,
	executeCheckoutAttempt,
	type CheckoutExecutionStage,
} from "./execution";
import {
	beginCheckoutResume,
	clearCheckoutResume,
	loadCheckoutResume,
	saveCheckoutResume,
} from "./storage";
import { hashCheckoutCapability, signCheckoutPayerProof } from "./proof";
import type {
	Address,
	CheckoutAttempt,
	CheckoutQuote,
	CheckoutResponse,
	Eip1193Provider,
	Hex,
} from "./types";
import {
	connectProvider,
	explorerTransactionUrl,
	injectedProvider,
	shortAddress,
} from "./walletProvider";

type UiStage = "idle" | "connecting" | "quoting" | "authorizing" | CheckoutExecutionStage;
type ResultState = "processing" | "paid" | "failed" | null;

function usdc(atomic: string): string {
	return formatAmount(formatUnits(BigInt(atomic), 6), "USDC");
}

function isTerminal(status: CheckoutAttempt["status"]): boolean {
	return ["paid", "overpaid", "failed", "expired", "canceled"].includes(status);
}

export default function ExternalWalletCheckout({
	checkout,
	amount,
	onPaid,
}: {
	checkout: CheckoutResponse;
	amount: string;
	onPaid: (settledAmount: string) => void;
}) {
	const { t } = useTranslation();
	const [networkId, setNetworkId] = useState(
		() => loadCheckoutResume(checkout.link.id)?.chainId ?? checkout.networks[0]?.chain_id ?? 0,
	);
	const [provider, setProvider] = useState<Eip1193Provider | null>(null);
	const [account, setAccount] = useState<Address | null>(null);
	const [quote, setQuote] = useState<CheckoutQuote | null>(null);
	const [attempt, setAttempt] = useState<CheckoutAttempt | null>(null);
	const [attemptCapability, setAttemptCapability] = useState(
		() => loadCheckoutResume(checkout.link.id)?.attemptCapability ?? null,
	);
	const [sourceTxHash, setSourceTxHash] = useState<Hex | null>(null);
	const [stage, setStage] = useState<UiStage>("idle");
	const [reviewing, setReviewing] = useState(false);
	const [error, setError] = useState("");
	const [result, setResult] = useState<ResultState>(null);

	const network = useMemo(
		() => checkout.networks.find((candidate) => candidate.chain_id === networkId) ?? checkout.networks[0],
		[checkout.networks, networkId],
	);
	const busy = stage !== "idle";
	const fixedAmount = checkout.intent.amount_mode === "fixed";
	const amountValid = Number(amount) > 0;
	const hasInjectedWallet = injectedProvider() !== null;

	const stageLabel: Record<Exclude<UiStage, "idle">, string> = {
		connecting: t("pay.externalConnecting"),
		quoting: t("pay.externalQuoting"),
		authorizing: t("pay.externalAuthorizing"),
		checking: t("pay.externalChecking"),
		permit: t("pay.externalPermit"),
		approving: t("pay.externalApproving"),
		submitting: t("pay.externalSubmitting"),
		confirming: t("pay.externalConfirming"),
	};

	const registerWithRetry = useCallback(
		async (current: CheckoutAttempt, hash: Hex, capability: string) => {
			for (let index = 0; index < 5; index += 1) {
				try {
					const registered = await registerCheckoutTransaction({
						linkId: checkout.link.id,
						attemptId: current.id,
						attemptCapability: capability,
						sourceTxHash: hash,
					});
					setAttempt(registered);
					return;
				} catch {
					if (index < 4) await new Promise((resolve) => window.setTimeout(resolve, 2_000 * (index + 1)));
				}
			}
			setError(t("pay.externalRegisterPending"));
		},
		[checkout.link.id, t],
	);

	useEffect(() => {
		const resume = loadCheckoutResume(checkout.link.id);
		if (!resume?.attemptId) return;
		let canceled = false;
		void getCheckoutAttempt(checkout.link.id, resume.attemptId, resume.attemptCapability)
			.then((restored) => {
				if (canceled) return;
				setAttempt(restored);
				setSourceTxHash((restored.source_tx_hash ?? resume.sourceTxHash) as Hex | null);
				if (!restored.source_tx_hash && resume.sourceTxHash) {
					void registerWithRetry(restored, resume.sourceTxHash as Hex, resume.attemptCapability);
				}
				if (restored.status === "paid" || restored.status === "overpaid") {
					clearCheckoutResume(checkout.link.id);
					setResult("paid");
					onPaid(formatUnits(BigInt(restored.settled_amount_atomic !== "0" ? restored.settled_amount_atomic : checkout.intent.amount_atomic), 6));
				} else if (["failed", "expired", "canceled"].includes(restored.status)) {
					clearCheckoutResume(checkout.link.id);
					setResult("failed");
				} else if (restored.source_tx_hash || resume.sourceTxHash) {
					setResult("processing");
				}
			})
			.catch(() => {
				// Keep the local record: a temporary API outage must not erase the
				// transaction hash needed to recover the payment.
			});
		return () => {
			canceled = true;
		};
	}, [checkout.intent.amount_atomic, checkout.link.id, onPaid, registerWithRetry]);

	const attemptId = attempt?.id;
	const attemptStatus = attempt?.status;
	useEffect(() => {
		if (!attemptId || !attemptCapability || !sourceTxHash || !attemptStatus || isTerminal(attemptStatus)) return;
		let canceled = false;
		let timer: number | undefined;
		const poll = async () => {
			try {
				const current = await getCheckoutAttempt(checkout.link.id, attemptId, attemptCapability);
				if (canceled) return;
				setAttempt(current);
				if (current.status === "paid" || current.status === "overpaid") {
					clearCheckoutResume(checkout.link.id);
					setResult("paid");
					onPaid(formatUnits(BigInt(current.settled_amount_atomic !== "0" ? current.settled_amount_atomic : checkout.intent.amount_atomic), 6));
					return;
				}
				if (["failed", "expired", "canceled"].includes(current.status)) {
					clearCheckoutResume(checkout.link.id);
					setResult("failed");
					return;
				}
			} catch {
				// Reconciliation is durable; a transient read failure only delays UI.
			}
			timer = window.setTimeout(poll, 3_000);
		};
		void poll();
		return () => {
			canceled = true;
			if (timer !== undefined) window.clearTimeout(timer);
		};
	}, [attemptCapability, attemptId, attemptStatus, checkout.intent.amount_atomic, checkout.link.id, onPaid, sourceTxHash]);

	useEffect(() => {
		if (!provider) return;
		const handleAccountsChanged = (...args: unknown[]) => {
			const accounts = args[0] as string[] | undefined;
			const next = accounts?.[0];
			if (!next || !/^0x[0-9a-fA-F]{40}$/u.test(next)) {
				setAccount(null);
				return;
			}
			setAccount(next as Address);
			setQuote(null);
			setError("");
		};
		const handleChainChanged = (...args: unknown[]) => {
			const value = args[0];
			if (typeof value !== "string") return;
			const next = Number.parseInt(value, 16);
			if (checkout.networks.some((candidate) => candidate.chain_id === next)) setNetworkId(next);
			setQuote(null);
		};
		provider.on?.("accountsChanged", handleAccountsChanged);
		provider.on?.("chainChanged", handleChainChanged);
		return () => {
			provider.removeListener?.("accountsChanged", handleAccountsChanged);
			provider.removeListener?.("chainChanged", handleChainChanged);
		};
	}, [checkout.networks, provider]);

	function describeError(value: unknown): string {
		if (value instanceof CheckoutExecutionError) {
			if (value.code === "USER_REJECTED") return t("pay.externalCanceled");
			if (value.code === "INSUFFICIENT_USDC") return t("pay.externalInsufficient", { network: network?.name ?? "" });
			if (value.code === "WRONG_WALLET") return t("pay.externalWrongWallet");
			if (value.code === "APPROVAL_PENDING") return t("pay.externalApprovalPending");
			return t("pay.externalExecutionError");
		}
		if (value instanceof ApiError) {
			if (value.code === "ATTEMPT_ACTIVE") return t("pay.externalAttemptActive");
			if (value.code === "QUOTE_STALE") return t("pay.externalQuoteExpired");
			return value.message || t("pay.externalApiError");
		}
		if (value instanceof Error && value.message === "INJECTED_WALLET_UNAVAILABLE") {
			return t("pay.noInjectedWallet");
		}
		return t("pay.externalExecutionError");
	}

	async function connect() {
		setStage("connecting");
		setError("");
		try {
			const connected = await connectProvider();
			setProvider(connected.provider);
			setAccount(connected.account);
			if (checkout.networks.some((candidate) => candidate.chain_id === connected.chainId)) {
				setNetworkId(connected.chainId);
			}
		} catch (value) {
			setError(describeError(value));
		} finally {
			setStage("idle");
		}
	}

	async function reviewPayment() {
		if (!account || !network || !amountValid) return;
		setError("");
		if (attempt && !isTerminal(attempt.status) && !attempt.source_tx_hash) {
			if (attempt.payer.toLowerCase() !== account.toLowerCase()) {
				setError(t("pay.externalWrongWallet"));
				return;
			}
			setReviewing(true);
			return;
		}
		setStage("quoting");
		try {
			const resume = beginCheckoutResume(checkout.link.id, account, network.chain_id);
			setAttemptCapability(resume.attemptCapability);
			const next = await createCheckoutQuote({
				linkId: checkout.link.id,
				payer: account,
				sourceChainId: network.chain_id,
				attemptCapabilityHash: await hashCheckoutCapability(resume.attemptCapability),
				...(fixedAmount ? {} : { amount }),
			});
			setQuote(next);
			setReviewing(true);
		} catch (value) {
			setError(describeError(value));
		} finally {
			setStage("idle");
		}
	}

	async function confirmPayment() {
		if (!provider || !account || !network || (!quote && !attempt)) return;
		setReviewing(false);
		setError("");
		setStage("authorizing");
		let current = attempt;
		let resume = beginCheckoutResume(checkout.link.id, account, network.chain_id);
		setAttemptCapability(resume.attemptCapability);
		let walletTransactionBroadcast = false;
		try {
			if (!current) {
				if (!quote) return;
				const payerProofSignature = await signCheckoutPayerProof({ provider, payer: account,
					message: quote.payer_proof_message });
				current = await createCheckoutAttempt({
					linkId: checkout.link.id,
					quoteId: quote.id,
					idempotencyKey: resume.idempotencyKey,
					attemptCapability: resume.attemptCapability,
					payerProofSignature,
				});
				setAttempt(current);
				resume = saveCheckoutResume({ ...resume, attemptId: current.id });
			}

			const execution = await executeCheckoutAttempt({
				provider,
				payer: account,
				network,
				attempt: current,
				onStage: setStage,
				onWalletTransaction: (hash, kind) => {
					walletTransactionBroadcast = true;
					if (kind === "payment") {
						setSourceTxHash(hash);
						resume = saveCheckoutResume({ ...resume, attemptId: current?.id ?? null, sourceTxHash: hash });
					}
				},
				onSourceTransaction: async (hash) => {
					walletTransactionBroadcast = true;
					await registerWithRetry(current as CheckoutAttempt, hash, resume.attemptCapability);
				},
			});
			setSourceTxHash(execution.sourceTxHash);
			setResult("processing");
		} catch (value) {
			setError(describeError(value));
			if (current && !walletTransactionBroadcast) {
				try {
					await cancelCheckoutAttempt(current.id, resume.attemptCapability);
					clearCheckoutResume(checkout.link.id);
					setAttempt(null);
				} catch {
					// The authorization expires by itself; keeping the resume record is
					// safer than losing an attempt whose state could not be confirmed.
				}
			}
		} finally {
			setStage("idle");
		}
	}

	if (!network) {
		return (
			<p role="status" className="text-center text-[13px] text-danger">
				{t("pay.externalNoNetworks")}
			</p>
		);
	}

	const activeFees = quote
		? {
			platform: quote.platform_fee_atomic,
			network: quote.cctp_fee_atomic,
			gross: quote.gross_payer_amount_atomic,
			route: quote.route,
		}
		: attempt
			? {
				platform: attempt.fee_snapshot.platform_fee_atomic,
				network: attempt.fee_snapshot.network_fee_max_atomic,
				gross: attempt.fee_snapshot.gross_payer_amount_atomic,
				route: attempt.route,
			}
			: null;
	const explorerUrl = sourceTxHash ? explorerTransactionUrl(network.chain_id, sourceTxHash) : null;

	if (result) {
		return (
			<div role="status" aria-live="polite">
			<InsetPanel className="mt-5 text-center">
				<h2 className="font-display text-[20px] text-text">
					{result === "paid"
						? t("pay.externalPaidTitle")
						: result === "failed"
							? t("pay.externalFailedTitle")
							: t("pay.externalProcessingTitle")}
				</h2>
				<p className="mt-2 text-[13px] leading-relaxed text-text-muted">
					{result === "paid"
						? t("pay.externalPaidBody")
						: result === "failed"
							? t("pay.externalFailedBody")
							: t("pay.externalProcessingBody", { network: network.name })}
				</p>
				{explorerUrl ? (
					<a className="mt-4 inline-block text-[13px] font-semibold text-cat-300 underline underline-offset-4" href={explorerUrl} target="_blank" rel="noreferrer">
						{t("pay.externalViewTransaction")}
						<span className="sr-only"> {t("pay.opensNewWindow")}</span>
					</a>
				) : null}
			</InsetPanel>
			</div>
		);
	}

	return (
		<>
			{reviewing && activeFees ? (
				<ConfirmSheet
					title={t("pay.externalReviewTitle")}
					amountLabel={t("pay.externalTotal")}
					amount={usdc(activeFees.gross)}
					unit="USDC"
					warning={t("pay.externalGasWarning")}
					confirmLabel={t("pay.externalConfirm")}
					paymentAction
					onConfirm={() => void confirmPayment()}
					onCancel={() => setReviewing(false)}
				>
					<InsetPanel className="mb-3">
						<SummaryRow label={t("pay.externalMerchantReceives")} value={`${usdc(checkout.intent.amount_atomic === "0" ? (quote?.settlement_amount_atomic ?? "0") : checkout.intent.amount_atomic)} USDC`} />
						<SummaryRow label={t("pay.externalServiceFee")} value={`${usdc(activeFees.platform)} USDC`} />
						<SummaryRow label={t("pay.externalRouteFee")} value={`${usdc(activeFees.network)} USDC`} />
						<SummaryRow label={t("pay.externalFromNetwork")} value={network.name} />
					</InsetPanel>
				</ConfirmSheet>
			) : null}

			<div className="mt-6 border-t border-border pt-5">
				<SectionLabel>{t("pay.externalWhereUsdc")}</SectionLabel>
				<label className="block">
					<span className="sr-only">{t("pay.externalNetworkLabel")}</span>
					<select
						value={network.chain_id}
						onChange={(event) => {
							setNetworkId(Number(event.target.value));
							setQuote(null);
							setError("");
						}}
						disabled={busy || Boolean(attempt && !isTerminal(attempt.status))}
						className="meli-field h-12 w-full text-[14px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cat-300"
					>
						{checkout.networks.map((candidate) => (
							<option key={candidate.chain_id} value={candidate.chain_id}>{candidate.name}</option>
						))}
					</select>
				</label>
				<p className="mt-2 text-[12px] leading-relaxed text-text-faint">{t("pay.externalNetworkHint")}</p>
			</div>

			{account ? (
				<InsetPanel className="mt-4 flex items-center justify-between gap-3">
					<div className="min-w-0">
						<p className="text-[11px] text-text-faint">{t("pay.externalBrowserWallet")}</p>
						<p className="truncate font-mono text-[13px] text-text">{shortAddress(account)}</p>
					</div>
					<button type="button" className="text-[12px] font-semibold text-cat-300 underline underline-offset-4" onClick={() => void connect()} disabled={busy}>
						{t("pay.externalChangeWallet")}
					</button>
				</InsetPanel>
			) : null}

			{error ? (
				<p role="alert" className="mt-4 text-center text-[13px] leading-relaxed text-danger">
					{error}
				</p>
			) : null}
			{busy ? (
				<p role="status" aria-live="polite" className="mt-4 text-center text-[13px] text-text-muted animate-pulse-soft">
					{stageLabel[stage as Exclude<UiStage, "idle">]}
				</p>
			) : null}

			<TransactionActions hint={t("pay.externalNoAccountHint")}>
				{!account ? (
					<div className="grid gap-3">
						{hasInjectedWallet ? (
							<button type="button" onClick={() => void connect()} disabled={busy} className="btn btn-money btn-block">
								{t("pay.externalConnectBrowser")}
							</button>
						) : null}
						{!hasInjectedWallet ? (
							<p className="text-center text-[12px] leading-relaxed text-text-muted">
								{t("pay.externalOpenInWalletBrowser")}
							</p>
						) : null}
					</div>
				) : (
					<button type="button" onClick={() => void reviewPayment()} disabled={busy || !amountValid || !network} className="btn btn-money btn-block">
						{attempt && !attempt.source_tx_hash ? t("pay.externalResume") : t("pay.externalReview")}
					</button>
				)}
			</TransactionActions>
		</>
	);
}

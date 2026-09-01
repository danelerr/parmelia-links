// Earn ("Modo Ahorro"): USDC supply on Aave v3, straight from the user's smart
// account. Design: docs/design/defi.md v2.0 — one product, one asset, one protocol,
// zero custody. The rate is VARIABLE and never promised; the risk copy at the
// bottom is mandatory product copy, not decoration. Flow mirrors Swap:
// /earn/prepare → passkey signature → /pay/submit (standard lifecycle), with
// the shared ConfirmSheet + StageOverlay (central UX architecture document, R-4).

import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import { apiFetch } from "../lib/api";
import { signWithPasskey } from "../lib/webauthn";
import { submitUserOp } from "../lib/submit";
import { usePaymentStatus } from "../hooks/usePaymentStatus";
import { usePasskeyGuidance } from "../hooks/usePasskeyGuidance";
import { userOperationChallenge, type PreparedUserOperation } from "../lib/eip712";
import { activeNetwork } from "../lib/activeNetwork";
import { getNetworkConfig, isSupportedChainKey } from "../lib/networks";
import { notifyError } from "../lib/notify";
import { track } from "../lib/analytics";
import { formatNumber } from "../lib/format";
import AmountInput from "../components/AmountInput";
import Logo from "../components/Logo";
import MeliSprite from "../components/brand/MeliSprite";
import PixelRail from "../components/brand/PixelRail";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import StageOverlay from "../components/StageOverlay";
import ConfirmSheet from "../components/ConfirmSheet";
import TxResult from "../components/TxResult";
import { Skeleton } from "../components/Skeleton";
import SigningDetails from "../components/SigningDetails";
import PrimaryNav from "../components/PrimaryNav";
import { MoneyPanel, PanelActions } from "../components/finance/FinancialPrimitives";

interface EarnConfig {
	enabled: boolean;
	canDeposit: boolean;
	canWithdraw: boolean;
	apyPercent: number;
	savings: string | null;
	available: string | null;
	balanceStatus: "fresh" | "stale" | "unavailable";
	estimatedEarnings: string | null;
	protocol: string;
	networkName: string;
	poolAddress: string | null;
}

type Action = "deposit" | "withdraw";
type Stage = "idle" | "preparing" | "signing" | "sending";

type PreparedEarn = PreparedUserOperation & {
	summary: {
		action: Action;
		amount: string;
		apyPercent: number;
		withdrawAll: boolean;
	};
};

export default function Earn({ user }: { user: User }) {
	const { t } = useTranslation();
	const [searchParams] = useSearchParams();
	const requestedChainKey = searchParams.get("chainKey");
	const requestedNetwork = requestedChainKey && isSupportedChainKey(requestedChainKey)
		? getNetworkConfig(requestedChainKey)
		: null;
	const routeMatchesHome = requestedChainKey === null || requestedChainKey === activeNetwork.key;
	const requestedNetworkName = requestedNetwork?.name ?? requestedChainKey ?? activeNetwork.name;
	const guideToPasskeys = usePasskeyGuidance();
	const [config, setConfig] = useState<EarnConfig | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [action, setAction] = useState<Action>("deposit");
	const actionRef = useRef<Action>("deposit");
	const [amount, setAmount] = useState("");
	const [useMax, setUseMax] = useState(false);
	const [prepared, setPrepared] = useState<PreparedEarn | null>(null);
	const [stage, setStage] = useState<Stage>("idle");
	const [result, setResult] = useState<{
		action: Action;
		amount: string;
		pending: boolean;
		userOpHash: string;
	} | null>(null);

	// When the submit came back in flight (202/duplicate), keep polling on the
	// success screen and flip the copy when the operation settles.
	const poll = usePaymentStatus(
		result?.pending ? user : null,
		result?.pending ? result.userOpHash : null,
	);

	const loadConfig = useCallback(async (fresh = false): Promise<EarnConfig | null> => {
		if (!routeMatchesHome) return null;
		try {
			if (!fresh) setLoadFailed(false);
			const data = await apiFetch<EarnConfig>(
				fresh ? "/earn/config?fresh=1" : "/earn/config",
				{ user },
			);
			setConfig(data);
			return data;
		} catch {
			if (!fresh) setLoadFailed(true);
			return null;
		}
	}, [routeMatchesHome, user]);

	useEffect(() => {
		if (!routeMatchesHome) return;
		queueMicrotask(() => {
			void loadConfig().then((loaded) => {
				if (loaded) void loadConfig(true);
			});
		});
	}, [loadConfig, routeMatchesHome]);

	// The savings/available split only reflects the operation once it settles.
	useEffect(() => {
		if (!routeMatchesHome) return;
		if (poll.status === "included" || poll.status === "confirmed") {
			queueMicrotask(() => void loadConfig(true));
		}
	}, [poll.status, loadConfig, routeMatchesHome]);

	const sourceBalance = action === "deposit" ? config?.available : config?.savings;
	const amountNumber = Number(amount || "0");
	const canContinue =
		!!config &&
		(action === "deposit" ? config.canDeposit : config.canWithdraw) &&
		(useMax
			? Number(sourceBalance || "0") > 0
			: amountNumber > 0 && amountNumber <= Number(sourceBalance || "0"));

	const stageCopy: Record<Exclude<Stage, "idle">, string> = {
		preparing: t("earn.stagePreparing"),
		signing: t("earn.stageSigning"),
		sending: t("earn.stageSending"),
	};

	if (!routeMatchesHome) {
		return (
			<Screen>
				<BackHeader to="/" replace title={t("earn.title")} />
				<div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
					<MeliSprite name="head-cautious" className="mb-5 w-24" />
					<p className="font-display text-[22px] text-text">{t("earn.networkUnavailableTitle", { network: requestedNetworkName })}</p>
					<p className="mt-3 max-w-[300px] text-[13px] leading-relaxed text-text-muted">
						{t("earn.networkUnavailableBody", { network: requestedNetworkName, homeNetwork: activeNetwork.name })}
					</p>
				</div>
			</Screen>
		);
	}

	function pickAction(next: Action) {
		actionRef.current = next;
		setAction(next);
		setAmount("");
		setUseMax(false);
	}

	function handleUseAll() {
		const requestedAction = action;
		const currentBalance = sourceBalance;
		if (!currentBalance || Number(currentBalance) <= 0) return;
		// Respond immediately with the last evidenced balance. For withdrawals the
		// Worker resolves Aave's protocol-level max from the live aToken balance,
		// so this decimal is an estimate for display rather than the execution cap.
		setAmount(currentBalance);
		// Only withdrawals support the protocol-level "everything" sentinel
		// (avoids interest dust accrued between prepare and execution).
		setUseMax(requestedAction === "withdraw");

		// Reconcile the displayed estimate without blocking the tap. If the user
		// changes action while this is in flight, leave the new form untouched.
		void loadConfig(true).then((latest) => {
			if (actionRef.current !== requestedAction) return;
			const latestBalance = requestedAction === "deposit" ? latest?.available : latest?.savings;
			if (!latestBalance || Number(latestBalance) <= 0) return;
			setAmount(latestBalance);
			setUseMax(requestedAction === "withdraw");
		});
	}

	async function prepareForReview() {
		if (!config) return;
		setStage("preparing");
		try {
			const prep = await apiFetch<PreparedEarn>(
				"/earn/prepare",
				// A numeric amount remains compatible with an older Worker; the
				// explicit flag tells the current Worker to use Aave's full-withdraw.
				{ user, body: { action, amount, withdrawAll: useMax } },
			);
			userOperationChallenge(prep, activeNetwork.chainId);
			setPrepared(prep);
		} catch (err) {
			notifyError(err, t("earn.error"));
		} finally {
			setStage("idle");
		}
	}

	async function confirmAndRun() {
		const prep = prepared;
		if (!prep) return;
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

			track(prep.summary.action === "deposit" ? "earn_deposit" : "earn_withdraw", {});
			setResult({
				action: prep.summary.action,
				amount: prep.summary.amount,
				pending: !submit.confirmed,
				userOpHash: prep.userOpHash,
			});
			setAmount("");
			setUseMax(false);
			if (submit.confirmed) void loadConfig(true);
		} catch (err) {
			if (!guideToPasskeys(err, prep.credentialId)) {
				notifyError(err, t("earn.error"));
			}
		} finally {
			setStage("idle");
		}
	}

	// ===== Result (success / in-flight / failed) =====
	if (result) {
		const opFailed = result.pending && poll.status === "failed";
		const settled =
			!result.pending ||
			poll.status === "included" ||
			poll.status === "confirmed";
		return (
			<Screen>
				<BackHeader to="/" replace title={t("earn.title")} />
				<TxResult
					state={opFailed ? "failed" : settled ? "success" : "pending"}
					lead={
						opFailed
							? t("earn.failedLead")
							: settled
								? result.action === "deposit"
									? t("earn.successDeposit")
									: t("earn.successWithdraw")
								: t("earn.pendingLead")
					}
					amount={formatNumber(result.amount, 2)}
					unit="USDC"
					body={opFailed ? t("earn.failedBody") : settled ? t("earn.successBody") : t("earn.pendingBody")}
				/>
				<button onClick={() => setResult(null)} className="btn btn-primary btn-block">
					{t("common.back")}
				</button>
			</Screen>
		);
	}

	const shownSavings =
		config?.savings === null || config?.savings === undefined
			? "—"
			: formatNumber(config.savings, 6);
	const shownAvailable =
		config?.available === null || config?.available === undefined
			? "—"
			: formatNumber(config.available, 6);

	// ===== Main =====
	return (
		<Screen withPrimaryNav>
			<StageOverlay label={stage === "idle" ? null : stageCopy[stage]} spinner={stage !== "signing"} />
			{prepared && config && (
				<ConfirmSheet
					title={prepared.summary.action === "deposit" ? t("earn.confirmDepositTitle") : t("earn.confirmWithdrawTitle")}
					amount={formatNumber(prepared.summary.amount, 6)}
					unit="USDC"
					confirmLabel={t("earn.confirmAction")}
					onConfirm={() => void confirmAndRun()}
					onCancel={() => setPrepared(null)}
				>
					<p className="text-[13px] text-text-muted leading-relaxed text-center mb-3">
						{prepared.summary.action === "deposit"
							? t("earn.confirmDepositBody", { amount: formatNumber(prepared.summary.amount, 6) })
							: prepared.summary.withdrawAll
								? t("earn.confirmWithdrawAllBody", { amount: formatNumber(prepared.summary.amount, 6) })
								: t("earn.confirmWithdrawBody", { amount: formatNumber(prepared.summary.amount, 6) })}
					</p>
					{prepared.summary.action === "deposit" && (
						<p className="text-[12px] text-text-faint text-center mb-5">
							{t("earn.apyLine", { apy: prepared.summary.apyPercent })}
						</p>
					)}
					<SigningDetails payload={prepared.signingPayload} networkName={activeNetwork.name} />
				</ConfirmSheet>
			)}
			<header className="mb-6">
				<p className="meli-kicker mb-3">{t("earn.eyebrow")}</p>
				<h1 className="font-display text-[36px] leading-[.94]">{t("earn.title")}</h1>
				<p className="mt-3 text-[13px] leading-relaxed text-text-muted">{t("earn.intro")}</p>
			</header>
			<PixelRail state={config?.enabled ? "done" : "future"} className="mb-5" />

			{!config && !loadFailed && (
				<div className="flex-1" aria-busy="true">
					<div className="rounded-[18px] bg-surface p-5 mb-4 shadow-e1" aria-hidden="true">
						<Skeleton className="h-3.5 w-24 rounded-[6px] mb-3" />
						<Skeleton className="h-10 w-40 rounded-[12px] mb-3" />
						<Skeleton className="h-3 w-28 rounded-[6px]" />
					</div>
					<div className="rounded-[18px] bg-surface p-5 shadow-e1" aria-hidden="true">
						<Skeleton className="h-10 w-full rounded-full mb-5" />
						<Skeleton className="h-3.5 w-36 rounded-[6px] mb-4" />
						<Skeleton className="h-10 w-32 rounded-[10px] mb-5" />
						<Skeleton className="h-12 w-full rounded-full" />
					</div>
				</div>
			)}

			{loadFailed && (
				<div className="flex-1 flex flex-col items-center justify-center text-center px-6">
					<p className="text-[15px] text-text mb-3">{t("earn.loadError")}</p>
					<button onClick={() => void loadConfig(true)} className="btn btn-ghost btn-sm">
						{t("earn.retry")}
					</button>
				</div>
			)}

			{config && !config.enabled && (
				<div className="flex-1 flex flex-col items-center justify-center text-center px-6">
					<Logo className="w-12 mb-5 opacity-40" />
					<p className="text-[15px] text-text mb-1">{t("earn.disabledTitle")}</p>
					<p className="text-[13px] text-text-muted max-w-[280px] leading-relaxed">{t("earn.disabledBody")}</p>
				</div>
			)}

			{config && config.enabled && (
				<>
					{/* Savings card */}
					<MoneyPanel className="mb-4 min-h-[150px] pr-24">
						<p className="text-[13px] text-text-muted mb-2">{t("earn.growingLabel")}</p>
						<p className="type-mono mb-2 text-[38px] font-bold leading-none text-text">
							{shownSavings} <span className="text-[20px]">USDC</span>
						</p>
						<p className="text-[12px] text-text-faint">{t("earn.apyLine", { apy: config.apyPercent })}</p>
						<p className="mt-3 text-[13px] text-growth">{config.estimatedEarnings === null ? t("earn.earningsUnavailable") : t("earn.earnings", { amount: formatNumber(config.estimatedEarnings, 6) })}</p>
						<MeliSprite name="body-sleeping" className="pointer-events-none absolute -bottom-3 -right-2 w-28" />
					</MoneyPanel>

					{/* Action */}
					<MoneyPanel className="mb-4">
						<div className="seg-track w-full mb-4">
							{(["deposit", "withdraw"] as Action[]).map((a) => (
								<button
									key={a}
									onClick={() => pickAction(a)}
									aria-pressed={action === a}
									data-active={action === a}
									className="seg-item flex-1"
								>
									{a === "deposit" ? t("earn.deposit") : t("earn.withdraw")}
								</button>
							))}
						</div>
						<div className="flex items-center justify-between mb-3">
							<span className="text-[13px] text-text-muted">
								{action === "deposit"
									? t("earn.availableLabel", { balance: shownAvailable })
									: t("earn.savedLabel", { balance: shownSavings })}
							</span>
							<button
								onClick={handleUseAll}
								disabled={!sourceBalance}
								className="text-[12px] text-text-faint"
							>
								{t("earn.useAll")}
							</button>
						</div>
						<AmountInput
							name="amount"
							aria-label={t("earn.amountLabel")}
							placeholder="0"
							value={amount}
							onChange={(v) => {
								setAmount(v);
								setUseMax(false);
							}}
							className="w-full bg-transparent font-display text-[34px] leading-none text-text placeholder:text-text-faint tabular mb-4"
						/>
						<PanelActions>
							<button
								onClick={() => void prepareForReview()}
								disabled={!canContinue || stage !== "idle"}
								className="btn btn-primary btn-block"
							>
								{t("earn.continue")}
							</button>
						</PanelActions>
						{config && action === "deposit" && !config.canDeposit && (
							<p role="status" aria-live="polite" className="text-[12px] text-text-muted mt-3 text-center">
								{t("earn.depositsUnavailable")}
							</p>
						)}
						{(config.available === null || config.savings === null) && (
							<p role="status" aria-live="polite" className="text-[12px] text-text-muted mt-3 text-center">
								{t("earn.balancesUnavailable")}
							</p>
						)}
					</MoneyPanel>

					<details className="meli-paper-card meli-paper-card--strong px-4 py-3">
						<summary className="min-h-11 cursor-pointer py-3 text-[13px] text-text-muted">{t("earn.detailsTitle")}</summary>
						<dl className="grid gap-3 pt-4 text-[12px]">
							<div className="flex justify-between gap-4"><dt className="text-text-faint">{t("earn.protocol")}</dt><dd>{config.protocol}</dd></div>
							<div className="flex justify-between gap-4"><dt className="text-text-faint">{t("signing.network")}</dt><dd>{config.networkName}</dd></div>
							{config.poolAddress ? <div><dt className="mb-1 text-text-faint">{t("earn.contract")}</dt><dd className="break-all font-mono text-[11px]">{config.poolAddress}</dd><a className="mt-2 inline-block text-info" href={`${activeNetwork.explorerBaseUrl}/address/${config.poolAddress}`} target="_blank" rel="noopener noreferrer">{t("settings.viewExplorer")} ↗</a></div> : null}
						</dl>
						<p className="mt-5 text-[12px] text-text-muted mb-2">{t("earn.riskTitle")}</p>
						<ul className="text-[12px] text-text-faint leading-relaxed list-disc pl-4 flex flex-col gap-1 pb-2">
							<li>{t("earn.risk1")}</li>
							<li>{t("earn.risk2")}</li>
							<li>{t("earn.risk3")}</li>
							<li>{t("earn.risk4")}</li>
						</ul>
					</details>
				</>
			)}
			<PrimaryNav />
		</Screen>
	);
}

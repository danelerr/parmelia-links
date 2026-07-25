// Earn ("Modo Ahorro"): USDC supply on Aave v3, straight from the user's smart
// account. Design: DEFI_DESIGN.md v2.0 — one product, one asset, one protocol,
// zero custody. The rate is VARIABLE and never promised; the risk copy at the
// bottom is mandatory product copy, not decoration. Flow mirrors Swap:
// /earn/prepare → passkey signature → /pay/submit (standard lifecycle), with
// the shared ConfirmSheet + StageOverlay (UX_DESIGN.md R-4).

import { useCallback, useEffect, useState } from "react";
import type { User } from "firebase/auth";
import { useTranslation } from "react-i18next";
import { apiFetch } from "../lib/api";
import { signWithPasskey } from "../lib/webauthn";
import { submitUserOp } from "../lib/submit";
import { usePaymentStatus } from "../hooks/usePaymentStatus";
import { hexToBytes } from "../lib/hex";
import { notifyError } from "../lib/notify";
import { track } from "../lib/analytics";
import { formatNumber } from "../lib/format";
import AmountInput from "../components/AmountInput";
import Logo from "../components/Logo";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import StageOverlay from "../components/StageOverlay";
import ConfirmSheet from "../components/ConfirmSheet";
import TxResult from "../components/TxResult";

interface EarnConfig {
	enabled: boolean;
	canDeposit: boolean;
	canWithdraw: boolean;
	apyPercent: number;
	savings: string;
	available: string;
}

type Action = "deposit" | "withdraw";
type Stage = "idle" | "preparing" | "signing" | "sending";

export default function Earn({ user }: { user: User }) {
	const { t } = useTranslation();
	const [config, setConfig] = useState<EarnConfig | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [action, setAction] = useState<Action>("deposit");
	const [amount, setAmount] = useState("");
	const [useMax, setUseMax] = useState(false);
	const [confirming, setConfirming] = useState(false);
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

	const loadConfig = useCallback(async () => {
		try {
			setLoadFailed(false);
			const data = await apiFetch<EarnConfig>("/earn/config", { user });
			setConfig(data);
		} catch {
			setLoadFailed(true);
		}
	}, [user]);

	useEffect(() => {
		void loadConfig();
	}, [loadConfig]);

	// The savings/available split only reflects the operation once it settles.
	useEffect(() => {
		if (poll.status === "confirmed") void loadConfig();
	}, [poll.status, loadConfig]);

	const sourceBalance = action === "deposit" ? config?.available : config?.savings;
	const amountNumber = Number(amount || "0");
	const canContinue =
		!!config &&
		(action === "deposit" ? config.canDeposit : config.canWithdraw) &&
		(useMax || (amountNumber > 0 && amountNumber <= Number(sourceBalance || "0")));

	const stageCopy: Record<Exclude<Stage, "idle">, string> = {
		preparing: t("earn.stagePreparing"),
		signing: t("earn.stageSigning"),
		sending: t("earn.stageSending"),
	};

	function pickAction(next: Action) {
		setAction(next);
		setAmount("");
		setUseMax(false);
	}

	function useAll() {
		if (!sourceBalance) return;
		setAmount(sourceBalance);
		// Only withdrawals support the protocol-level "everything" sentinel
		// (avoids interest dust accrued between prepare and execution).
		setUseMax(action === "withdraw");
	}

	async function handleConfirm() {
		if (!config) return;
		setStage("preparing");
		try {
			const prep = await apiFetch<{ userOpHash: string; credentialId: string | null }>(
				"/earn/prepare",
				{ user, body: { action, amount: useMax ? "max" : amount } },
			);

			setStage("signing");
			const assertion = await signWithPasskey(
				hexToBytes(prep.userOpHash as `0x${string}`),
				prep.credentialId,
			);

			setStage("sending");
			const submit = await submitUserOp(user, prep.userOpHash, assertion);

			track(action === "deposit" ? "earn_deposit" : "earn_withdraw", {});
			setResult({
				action,
				amount: useMax ? config.savings : amount,
				pending: !submit.confirmed,
				userOpHash: prep.userOpHash,
			});
			setAmount("");
			setUseMax(false);
			void loadConfig();
		} catch (err) {
			notifyError(err, t("earn.error"));
		} finally {
			setStage("idle");
		}
	}

	// The gradient CTA only OPENS the review sheet; prepare+sign+submit run only
	// after an explicit confirmation (same pattern as Pay and Crosschain).
	function confirmAndRun() {
		setConfirming(false);
		void handleConfirm();
	}

	// ===== Result (success / in-flight / failed) =====
	if (result) {
		const opFailed = result.pending && poll.status === "failed";
		const settled = !result.pending || poll.status === "confirmed";
		return (
			<Screen>
				<BackHeader to="/" title={t("earn.title")} />
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

	const shownAmount = useMax && config ? config.savings : amount;

	// ===== Main =====
	return (
		<Screen>
			<StageOverlay label={stage === "idle" ? null : stageCopy[stage]} spinner={stage !== "signing"} />
			{confirming && config && (
				<ConfirmSheet
					title={action === "deposit" ? t("earn.confirmDepositTitle") : t("earn.confirmWithdrawTitle")}
					amount={formatNumber(shownAmount, 2)}
					unit="USDC"
					confirmLabel={t("earn.confirmAction")}
					onConfirm={confirmAndRun}
					onCancel={() => setConfirming(false)}
				>
					<p className="text-[13px] text-text-muted leading-relaxed text-center mb-3">
						{action === "deposit"
							? t("earn.confirmDepositBody", { amount: formatNumber(shownAmount, 2) })
							: useMax
								? t("earn.confirmWithdrawAllBody", { amount: formatNumber(shownAmount, 2) })
								: t("earn.confirmWithdrawBody", { amount: formatNumber(shownAmount, 2) })}
					</p>
					{action === "deposit" && (
						<p className="text-[12px] text-text-faint text-center mb-5">
							{t("earn.apyLine", { apy: config.apyPercent })}
						</p>
					)}
				</ConfirmSheet>
			)}
			<BackHeader to="/" title={t("earn.title")} />

			{!config && !loadFailed && (
				<div className="flex-1 flex items-center justify-center">
					<p role="status" aria-live="polite" className="text-[13px] text-text-muted animate-pulse-soft">
						{t("earn.loading")}
					</p>
				</div>
			)}

			{loadFailed && (
				<div className="flex-1 flex flex-col items-center justify-center text-center px-6">
					<p className="text-[15px] text-text mb-3">{t("earn.loadError")}</p>
					<button onClick={() => void loadConfig()} className="btn btn-ghost btn-sm">
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
					<div className="bg-surface border border-border rounded-[18px] p-5 mb-4 shadow-e1">
						<p className="text-[13px] text-text-muted mb-2">{t("earn.savingsLabel")}</p>
						<p className="font-display text-[38px] leading-none text-text tabular mb-2">
							{formatNumber(config.savings, 2)} <span className="text-[20px]">USDC</span>
						</p>
						<p className="text-[12px] text-text-faint">{t("earn.apyLine", { apy: config.apyPercent })}</p>
					</div>

					{/* Action */}
					<div className="bg-surface border border-border rounded-[18px] p-5 mb-4 shadow-e1">
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
									? t("earn.availableLabel", { balance: formatNumber(config.available, 2) })
									: t("earn.savedLabel", { balance: formatNumber(config.savings, 2) })}
							</span>
							<button
								onClick={useAll}
								className="text-[12px] text-text-faint hover:text-text-muted transition-colors"
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
						<button
							onClick={() => setConfirming(true)}
							disabled={!canContinue || stage !== "idle"}
							className="btn btn-gradient btn-block"
						>
							{t("earn.continue")}
						</button>
						{config && action === "deposit" && !config.canDeposit && (
							<p role="status" aria-live="polite" className="text-[12px] text-text-muted mt-3 text-center">
								{t("earn.depositsUnavailable")}
							</p>
						)}
					</div>

					{/* Mandatory honest copy (DEFI_DESIGN §7.4) */}
					<div className="px-1">
						<p className="text-[12px] text-text-muted mb-2">{t("earn.riskTitle")}</p>
						<ul className="text-[12px] text-text-faint leading-relaxed list-disc pl-4 flex flex-col gap-1">
							<li>{t("earn.risk1")}</li>
							<li>{t("earn.risk2")}</li>
							<li>{t("earn.risk3")}</li>
							<li>{t("earn.risk4")}</li>
						</ul>
					</div>
				</>
			)}
		</Screen>
	);
}

// Account recovery (/recover): the screen for the guardian flow the server has
// had since V2 (propose -> 48h timelock -> execute, cancellable at any point).
// One state machine over a single `phase`; GET /account/passkey is the source
// of truth on mount and after every mutation. Requires Firebase auth + wallet
// but NOT a working passkey - exactly the situation of someone who lost their
// phone.
//
// Local pointer: the passkey created here is only promoted to "the recovery
// credential" AFTER the propose call succeeds. If a recovery is pending and
// this device has no pointer, the proposal belongs to another device - the
// only way forward from here is cancel-and-restart. Executing with a
// credential that is not the proposed signer would persist a credentialId
// whose key cannot sign (the server also rejects it: RECOVERY_SIGNER_MISMATCH).

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { User } from "../lib/firebase";
import { ApiError, apiFetch } from "../lib/api";
import { type AccountOperationResponse, waitForAccountOperation } from "../lib/accountOperations";
import {
	createPasskeyAvailabilityAssertion,
	createPasskey,
	PasskeyAlreadyOnAuthenticatorError,
	rememberPasskey,
	type PasskeyAuthenticationChallenge,
	type PasskeyCreationMode,
	type PasskeyRegistrationChallenge,
} from "../lib/webauthn";
import { isUserCancelled, notifyError, notifySuccess, notifyWarning } from "../lib/notify";
import { formatDateTime } from "../lib/format";
import { useViewTransitionNavigate } from "../hooks/useNav";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import StageOverlay from "../components/StageOverlay";
import TxResult from "../components/TxResult";
import LinkButton from "../components/LinkButton";
import StepUpLinkSheet from "../components/StepUpLinkSheet";
import { FormPageSkeleton } from "../components/Skeleton";
import {
	readMigratedStorage,
	removeMigratedStorage,
	writeStorage,
} from "../lib/storageMigration";
import {
	clearRecoveryStepUp,
	readRecoveryStepUp,
	type RecoveryStepUpAction,
	type StoredRecoveryStepUp,
} from "../lib/recoveryStepUp";

const POINTER_KEY = "gatopago:recovery-credential:v1";
const LEGACY_POINTER_KEY = "parmelia:recovery-credential:v1";

type RecoveryPointer = {
	registrationId?: string;
	credentialId: string;
	qx: string;
	qy: string;
	rpId?: string;
	proposedAt: string;
};

function readPointer(): RecoveryPointer | null {
	try {
		const raw = readMigratedStorage(POINTER_KEY, LEGACY_POINTER_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as RecoveryPointer;
		if (!parsed?.credentialId || !parsed?.qx || !parsed?.qy) return null;
		return parsed;
	} catch {
		return null;
	}
}

function clearPointer() {
	try {
		removeMigratedStorage(POINTER_KEY, LEGACY_POINTER_KEY);
	} catch {
		/* storage unavailable */
	}
}

type PasskeyStatus = {
	hasWallet: boolean;
	signerCount: number | null;
	recoveryPending: boolean | null;
	recoveryExecutableAfter: string | null;
};

type Phase =
	| "loading"
	| "no-wallet"
	| "intro"
	| "creating"
	| "proposing"
	| "pending"
	| "pending-elsewhere"
	| "ready"
	| "ready-elsewhere"
	| "executing"
	| "cancelling"
	| "success"
	| "cancelled"
	| "error";

function phaseFromStatus(status: PasskeyStatus): Phase {
	if (!status.hasWallet) return "no-wallet";
	if (!status.recoveryPending) return "intro";
	const executableAt = status.recoveryExecutableAfter
		? Date.parse(status.recoveryExecutableAfter)
		: 0;
	const ready = executableAt > 0 && Date.now() >= executableAt;
	const mine = readPointer() !== null;
	if (ready) return mine ? "ready" : "ready-elsewhere";
	return mine ? "pending" : "pending-elsewhere";
}

/** "46 h 12 min" above the hour, "58 min" below it. Never shows seconds. */
function countdownLabel(msLeft: number): string {
	const totalMinutes = Math.max(1, Math.ceil(msLeft / 60_000));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

export default function Recover({ user }: { user: User }) {
	const { t } = useTranslation();
	const navigate = useViewTransitionNavigate();
	const [phase, setPhase] = useState<Phase>("loading");
	const [status, setStatus] = useState<PasskeyStatus | null>(null);
	const [now, setNow] = useState(() => Date.now());
	// Inline double-tap confirmation for cancel (no ConfirmSheet: no amount here).
	const [cancelArmed, setCancelArmed] = useState(false);
	const [stepUpAction, setStepUpAction] = useState<"start" | "execute" | null>(null);
	const [stepUpProof, setStepUpProof] = useState<StoredRecoveryStepUp | null>(() => readRecoveryStepUp());
	const [existingKeyState, setExistingKeyState] = useState<
		"unchecked" | "checking" | "available" | "not-confirmed" | "duplicate"
	>("unchecked");
	const cancelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const refresh = useCallback(async () => {
		try {
			const next = await apiFetch<PasskeyStatus>("/account/passkey", { user });
			setStatus(next);
			setPhase(phaseFromStatus(next));
		} catch {
			setPhase("error");
		}
	}, [user]);

	useEffect(() => {
		let cancelled = false;
		queueMicrotask(() => {
			if (!cancelled) void refresh();
		});
		return () => {
			cancelled = true;
		};
	}, [refresh]);

	useEffect(() => () => {
		if (cancelTimer.current) clearTimeout(cancelTimer.current);
	}, []);

	const executableAt = status?.recoveryExecutableAfter
		? Date.parse(status.recoveryExecutableAfter)
		: 0;
	const reachedDeadline =
		(phase === "pending" || phase === "pending-elsewhere") &&
		executableAt > 0 &&
		now >= executableAt;
	const visiblePhase: Phase = reachedDeadline
		? readPointer()
			? "ready"
			: "ready-elsewhere"
		: phase;
	const waiting = visiblePhase === "pending" || visiblePhase === "pending-elsewhere";

	// 30s tick while waiting; crossing zero flips to ready without a reload.
	useEffect(() => {
		if (!waiting) return;
		const id = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(id);
	}, [waiting]);

	const handleStart = useCallback(async (
		stepUpToken: string,
		creationMode: PasskeyCreationMode = "device",
	) => {
		setPhase("proposing");
		let preflight: PasskeyRegistrationChallenge;
		try {
			preflight = await apiFetch<PasskeyRegistrationChallenge>(
				"/account/recovery/preflight",
				{
					user,
					body: {},
					headers: { "X-Step-Up-Token": stepUpToken },
				},
			);
		} catch (error) {
			if (error instanceof ApiError && error.code === "RECOVERY_IN_PROGRESS") {
				await refresh();
				return;
			}
			if (
				error instanceof ApiError &&
				(error.code === "STEP_UP_REQUIRED" || error.code === "STEP_UP_INVALID")
			) {
				setPhase("intro");
				setStepUpAction("start");
				return;
			}
			setPhase("error");
			return;
		}

		setPhase("creating");
		let created: Awaited<ReturnType<typeof createPasskey>>;
		try {
			if (!user.uid) throw new Error(t("common.sessionExpired"));
			const passkeyLabel = user.email || user.displayName || undefined;
			created = await createPasskey(user.uid, passkeyLabel, {
				...preflight,
				name: creationMode === "security-key"
					? t("webauthn.securityKeyName")
					: t("webauthn.recoveryKeyName"),
			}, creationMode);
		} catch (error) {
			// A dismissed OS prompt is not a failure: back to intro with a calm toast.
			setPhase("intro");
			if (error instanceof PasskeyAlreadyOnAuthenticatorError) {
				setExistingKeyState("duplicate");
				notifyWarning(
					t("recover.existingManagerKeyTitle"),
					t("recover.existingManagerKeyBody"),
				);
				return;
			}
			if (isUserCancelled(error)) notifyWarning(t("recover.keyDismissed"));
			else notifyError(error);
			return;
		}

		setPhase("proposing");
		try {
			const operation = await apiFetch<AccountOperationResponse>("/account/recovery/propose", {
				user,
				body: created,
				headers: { "X-Step-Up-Token": stepUpToken },
			});
			await waitForAccountOperation(user, operation);
			// Only NOW is this credential the proposed one - promote it.
			writeStorage(
				POINTER_KEY,
				JSON.stringify({ ...created, proposedAt: new Date().toISOString() }),
			);
			await refresh();
		} catch (error) {
			if (error instanceof ApiError && error.code === "RECOVERY_IN_PROGRESS") {
				// Someone proposed first. NEVER promote the key we just created: the
				// on-chain proposal is for a DIFFERENT qx/qy.
				await refresh();
				return;
			}
			setPhase("error");
		}
	}, [refresh, t, user]);

	const handleCheckExistingKey = useCallback(async () => {
		if (existingKeyState === "checking") return;
		setExistingKeyState("checking");
		try {
			const preflight = await apiFetch<PasskeyAuthenticationChallenge>(
				"/account/passkey/availability/preflight",
				{ user, body: {} },
			);
			const assertion = await createPasskeyAvailabilityAssertion(preflight);
			await apiFetch("/account/passkey/availability/verify", {
				user,
				body: assertion,
			});
			setExistingKeyState("available");
			notifySuccess(t("recover.existingKeyWorksTitle"), t("recover.existingKeyWorksBody"));
		} catch (error) {
			setExistingKeyState("not-confirmed");
			if (isUserCancelled(error)) {
				notifyWarning(t("security.keyCheckCancelledTitle"), t("security.keyCheckCancelledBody"));
				return;
			}
			notifyError(error, t("recover.existingKeyCheckFailed"));
		}
	}, [existingKeyState, t, user]);

	const handleExecute = useCallback(async (stepUpToken: string) => {
		const pointer = readPointer();
		if (!pointer) {
			await refresh();
			return;
		}
		setPhase("executing");
		try {
			const operation = await apiFetch<AccountOperationResponse>("/account/recovery/execute", {
				user,
				body: {
					registrationId: pointer.registrationId,
					credentialId: pointer.credentialId,
					qx: pointer.qx,
					qy: pointer.qy,
				},
				headers: { "X-Step-Up-Token": stepUpToken },
			});
			await waitForAccountOperation(user, operation);
			rememberPasskey(pointer);
			clearPointer();
			// The Home "new device?" banner earns a fresh start after a recovery.
			if (user.uid) {
				try {
					localStorage.removeItem(`gatopago:recovery-banner-dismissed:${user.uid}`);
					localStorage.removeItem(`parmelia:recovery-banner-dismissed:${user.uid}`);
				} catch {
					/* storage unavailable */
				}
			}
			setPhase("success");
		} catch (error) {
			if (error instanceof ApiError) {
				if (error.code === "RECOVERY_NOT_READY") {
					// Client clock ahead of the chain: silent correction, back to waiting.
					await refresh();
					return;
				}
				if (error.code === "RECOVERY_NONE") {
					// Cancelled in between (e.g. from the old phone). Honest, not an error.
					clearPointer();
					setPhase("cancelled");
					return;
				}
				if (error.code === "RECOVERY_SIGNER_MISMATCH") {
					// Our pointer is stale (cancelled + re-proposed elsewhere). Drop it;
					// the refetch lands on the *-elsewhere phase with the way out.
					clearPointer();
					await refresh();
					return;
				}
				if (error.code === "STEP_UP_REQUIRED" || error.code === "STEP_UP_INVALID") {
					setPhase("ready");
					setStepUpAction("execute");
					return;
				}
			}
			setPhase("error");
		}
	}, [refresh, user]);

	function runVerifiedStep(
		action: RecoveryStepUpAction,
		handler: (token: string) => Promise<void>,
	) {
		if (stepUpProof?.action !== action) {
			if (stepUpProof) {
				clearRecoveryStepUp();
				setStepUpProof(null);
			}
			setStepUpAction(action);
			return;
		}
		const token = stepUpProof.stepUpToken;
		clearRecoveryStepUp();
		setStepUpProof(null);
		void handler(token);
	}

	async function handleCancel() {
		if (!cancelArmed) {
			setCancelArmed(true);
			if (cancelTimer.current) clearTimeout(cancelTimer.current);
			cancelTimer.current = setTimeout(() => setCancelArmed(false), 4000);
			return;
		}
		if (cancelTimer.current) clearTimeout(cancelTimer.current);
		setCancelArmed(false);
		setPhase("cancelling");
		try {
			const operation = await apiFetch<AccountOperationResponse>("/account/recovery/cancel", { user, body: {} });
			await waitForAccountOperation(user, operation);
			clearPointer();
			setPhase("cancelled");
		} catch (error) {
			if (error instanceof ApiError && error.code === "RECOVERY_NONE") {
				// Already gone - same outcome the user wanted.
				clearPointer();
				setPhase("cancelled");
				return;
			}
			setPhase("error");
		}
	}

	const cancelButton = (
		<button onClick={handleCancel} className="btn-text mt-3">
			{cancelArmed ? t("recover.cancelConfirm") : t("recover.cancelCta")}
		</button>
	);

	const restartButton = (
		<button onClick={handleCancel} className="btn btn-primary btn-block mt-6">
			{cancelArmed ? t("recover.cancelConfirm") : t("recover.restartCta")}
		</button>
	);

	// ---- Overlay phases (the OS sheet or the network owns the screen) ----
	if (visiblePhase === "creating" || visiblePhase === "proposing" || visiblePhase === "executing" || visiblePhase === "cancelling") {
		const labels: Partial<Record<Phase, string>> = {
			creating: t("recover.creatingKey"),
			proposing: t("recover.proposing"),
			executing: t("recover.executing"),
			cancelling: t("recover.cancelling"),
		};
		return (
			<Screen>
				<StageOverlay label={labels[visiblePhase] ?? null} spinner={visiblePhase !== "creating"} />
			</Screen>
		);
	}

	if (visiblePhase === "loading") {
		return (
			<Screen>
				<BackHeader to="/settings/security" replace />
				<FormPageSkeleton />
			</Screen>
		);
	}

	if (visiblePhase === "no-wallet") {
		return (
			<Screen>
				<BackHeader to="/settings/security" replace title={t("recover.title")} />
				<div className="flex-1 flex flex-col items-center justify-center text-center px-6">
					<p className="text-[14px] text-text-muted mb-6">{t("recover.noWalletBody")}</p>
					<LinkButton to="/" replace className="btn btn-primary">
						{t("recover.successCta")}
					</LinkButton>
				</div>
			</Screen>
		);
	}

	if (visiblePhase === "intro") {
		const steps = [t("recover.step1"), t("recover.step2"), t("recover.step3")];
		return (
			<>
			<Screen>
				<BackHeader to="/settings/security" replace title={t("recover.title")} />

				<p className="text-[14px] text-text leading-relaxed mb-6">{t("recover.promise")}</p>

				<div className="meli-paper-card meli-paper-card--strong mb-5 p-6">
					<ol className="flex flex-col gap-4">
						{steps.map((step, i) => (
							<li key={i} className="flex items-start gap-3">
								<span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center border border-text bg-cat-500 text-[12px] font-semibold text-on-cat">
									{i + 1}
								</span>
								<p className="text-[14px] text-text leading-relaxed">{step}</p>
							</li>
						))}
					</ol>
				</div>

				<div className="mb-5 flex items-start gap-2 border-l-4 border-pending bg-pending/8 px-3.5 py-3 text-pending">
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
						<path d="M12 9v4M12 17h.01" />
						<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
					</svg>
					<p className="text-[12px] text-text-muted leading-relaxed">{t("recover.warning")}</p>
				</div>

				{stepUpProof?.action === "start" ? (
					<div className="mb-5 border-2 border-growth bg-growth/10 p-3.5" role="status">
						<p className="font-display text-[14px] text-growth">{t("recover.identityConfirmedTitle")}</p>
						<p className="mt-1 text-[12px] leading-relaxed text-text-muted">{t("recover.identityConfirmedBody")}</p>
					</div>
				) : null}

				{existingKeyState === "available" || existingKeyState === "duplicate" ? (
					<div className="mb-5 border-2 border-info bg-info/8 p-3.5" role="status">
						<p className="font-display text-[14px] text-info">
							{existingKeyState === "available"
								? t("recover.existingKeyWorksTitle")
								: t("recover.existingManagerKeyTitle")}
						</p>
						<p className="mt-1 text-[12px] leading-relaxed text-text-muted">
							{existingKeyState === "available"
								? t("recover.existingKeyWorksBody")
								: t("recover.existingManagerKeyBody")}
						</p>
						{existingKeyState === "duplicate" ? (
							<button
								type="button"
								onClick={() => runVerifiedStep(
									"start",
									(token) => handleStart(token, "security-key"),
								)}
								className="btn btn-ghost mt-3 min-h-10 px-4 text-[12px]"
							>
								{t("recover.usePhysicalKey")}
							</button>
						) : null}
					</div>
				) : null}

				<div className="flex-1" />

				{(status?.signerCount ?? 0) > 0 ? (
					<button
						type="button"
						onClick={() => void handleCheckExistingKey()}
						disabled={existingKeyState === "checking"}
						className="btn btn-primary btn-block"
					>
						{existingKeyState === "checking"
							? t("security.checkingKey")
							: t("recover.tryExistingKey")}
					</button>
				) : null}
				{existingKeyState === "available" ? (
					<button
						type="button"
						onClick={() => navigate("/settings/security", { replace: true })}
						className="btn btn-ghost btn-block mt-3"
					>
						{t("recover.backToSecurity")}
					</button>
				) : (
					<button
						onClick={() => runVerifiedStep(
							"start",
							(token) => handleStart(token, "device"),
						)}
						className={`${(status?.signerCount ?? 0) > 0 ? "btn-text" : "btn btn-primary btn-block"} mt-3`}
					>
						{stepUpProof?.action === "start"
							? t("recover.ctaConfirmed")
							: (status?.signerCount ?? 0) > 0
								? t("recover.noKeysAvailable")
								: t("recover.cta")}
					</button>
				)}
			</Screen>
			{stepUpAction === "start" ? (
				<StepUpLinkSheet
					user={user}
					action="start"
					onCancel={() => setStepUpAction(null)}
				/>
			) : null}
			</>
		);
	}

	if (visiblePhase === "pending" || visiblePhase === "pending-elsewhere") {
		const msLeft = Math.max(0, executableAt - now);
		return (
			<Screen>
				<BackHeader to="/settings/security" replace />
				<TxResult
					state="progress"
					lead={t("recover.pendingLead")}
					amount={countdownLabel(msLeft)}
					body={
						executableAt > 0
							? t("recover.pendingBody", { date: formatDateTime(executableAt) })
							: undefined
					}
				>
					{visiblePhase === "pending" ? (
						<>
							<p className="text-[13px] text-text-muted leading-relaxed max-w-[320px] mt-4">
								{t("recover.pendingWhy")}
							</p>
							<p className="text-[13px] text-text-faint leading-relaxed max-w-[320px] mt-3">
								{t("recover.pendingOldDevice")}
							</p>
							<LinkButton to="/" replace className="btn btn-primary mt-6">
								{t("recover.successCta")}
							</LinkButton>
							{cancelButton}
						</>
					) : (
						<>
							<p className="text-[13px] text-text-muted leading-relaxed max-w-[320px] mt-4">
								{t("recover.elsewhereBody")}
							</p>
							{restartButton}
						</>
					)}
				</TxResult>
			</Screen>
		);
	}

	if (visiblePhase === "ready" || visiblePhase === "ready-elsewhere") {
		return (
			<>
			<Screen>
				<BackHeader to="/settings/security" replace />
				<TxResult
					state="progress"
					lead={t("recover.readyLead")}
					body={visiblePhase === "ready" ? t("recover.readyBody") : t("recover.elsewhereBody")}
				>
					{visiblePhase === "ready" ? (
						<>
							<button onClick={() => runVerifiedStep("execute", handleExecute)} className="btn btn-primary btn-block mt-6">
								{stepUpProof?.action === "execute" ? t("recover.readyCtaConfirmed") : t("recover.readyCta")}
							</button>
							{cancelButton}
						</>
					) : (
						restartButton
					)}
				</TxResult>
			</Screen>
			{stepUpAction === "execute" ? (
				<StepUpLinkSheet
					user={user}
					action="execute"
					onCancel={() => setStepUpAction(null)}
				/>
			) : null}
			</>
		);
	}

	if (visiblePhase === "success") {
		return (
			<Screen>
				<TxResult state="success" lead={t("recover.successLead")} body={t("recover.successBody")}>
					<button onClick={() => navigate("/", { replace: true })} className="btn btn-primary btn-block mt-6">
						{t("recover.successCta")}
					</button>
				</TxResult>
			</Screen>
		);
	}

	if (visiblePhase === "cancelled") {
		return (
			<Screen>
				<BackHeader to="/" replace />
				<TxResult state="success" lead={t("recover.cancelledLead")} body={t("recover.cancelledBody")}>
					<LinkButton to="/" replace className="btn btn-primary mt-6">
						{t("recover.successCta")}
					</LinkButton>
					<button onClick={() => setPhase("intro")} className="btn-text mt-3">
						{t("recover.startAgain")}
					</button>
				</TxResult>
			</Screen>
		);
	}

	// error: retry re-reads the server state and lands on the right actionable phase.
	return (
		<Screen>
			<BackHeader to="/settings/security" replace />
			<TxResult state="failed" lead={t("recover.errorLead")} body={t("recover.errorBody")}>
				<button
					onClick={() => {
						setPhase("loading");
						void refresh();
					}}
					className="btn btn-primary btn-block mt-6"
				>
					{t("recover.retry")}
				</button>
			</TxResult>
		</Screen>
	);
}

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDialog } from "../hooks/useDialog";
import { apiFetch } from "../lib/api";
import type { User } from "../lib/firebase";
import { humanizeError } from "../lib/notify";

type CodeRequestResponse = {
	sent: true;
	maskedEmail: string;
	expiresInSeconds: number;
	resendAfterSeconds: number;
};

type CodeVerifyResponse = {
	stepUpToken: string;
	expiresInSeconds: number;
};

export default function StepUpCodeSheet({
	user,
	onVerified,
	onCancel,
}: {
	user: User;
	onVerified: (token: string) => void;
	onCancel: () => void;
}) {
	const { t, i18n } = useTranslation();
	const [sentTo, setSentTo] = useState<string | null>(null);
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState<"request" | "verify" | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [resendAt, setResendAt] = useState(0);
	const [clock, setClock] = useState(() => Date.now());
	const dialogRef = useDialog<HTMLDivElement>(() => {
		if (busy === null) onCancel();
	});

	useEffect(() => {
		if (!sentTo || resendAt <= Date.now()) return;
		const timer = window.setInterval(() => {
			const next = Date.now();
			setClock(next);
			if (next >= resendAt) window.clearInterval(timer);
		}, 1_000);
		return () => window.clearInterval(timer);
	}, [resendAt, sentTo]);

	const resendSeconds = Math.max(0, Math.ceil((resendAt - clock) / 1_000));

	async function requestCode() {
		setBusy("request");
		setError(null);
		try {
			const result = await apiFetch<CodeRequestResponse>("/auth/step-up/request", {
				user,
				body: {
					locale: i18n.resolvedLanguage?.startsWith("en") ? "en" : "es",
				},
			});
			setSentTo(result.maskedEmail);
			setCode("");
			setClock(Date.now());
			setResendAt(Date.now() + result.resendAfterSeconds * 1_000);
		} catch (cause) {
			setError(humanizeError(cause, t("stepUp.sendError")).message);
		} finally {
			setBusy(null);
		}
	}

	async function verifyCode() {
		if (!/^\d{6}$/.test(code)) {
			setError(t("stepUp.invalidCode"));
			return;
		}
		setBusy("verify");
		setError(null);
		try {
			const result = await apiFetch<CodeVerifyResponse>("/auth/step-up/verify", {
				user,
				body: { code },
			});
			onVerified(result.stepUpToken);
		} catch (cause) {
			setError(humanizeError(cause, t("stepUp.verifyError")).message);
		} finally {
			setBusy(null);
		}
	}

	return createPortal(
		<div
			className="dialog-backdrop fixed inset-0 z-[70] flex items-end justify-center px-5 animate-fade-in"
			style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
			onClick={busy ? undefined : onCancel}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="step-up-title"
				aria-describedby="step-up-description"
				tabIndex={-1}
				className="dialog-panel w-full max-w-sm p-6 animate-sheet-up"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="sheet-handle mb-5" aria-hidden="true" />
				<h2 id="step-up-title" className="font-display text-[24px] leading-tight">
					{t("stepUp.title")}
				</h2>
				<p id="step-up-description" className="mt-2 text-[13px] leading-relaxed text-text-muted">
					{sentTo
						? t("stepUp.sentTo", { email: sentTo })
						: t("stepUp.description")}
				</p>

				{sentTo ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void verifyCode();
						}}
						className="mt-5"
					>
						<label className="block text-[13px] text-text-muted">
							<span className="mb-2 block">{t("stepUp.codeLabel")}</span>
							<input
								type="text"
								name="recovery-one-time-code"
								inputMode="numeric"
								autoComplete="one-time-code"
								autoCapitalize="none"
								spellCheck={false}
								maxLength={6}
								pattern="[0-9]{6}"
								value={code}
								onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
								aria-invalid={error ? true : undefined}
								aria-describedby={error ? "step-up-error" : undefined}
								data-dialog-initial-focus="true"
								className="meli-field text-center font-display text-[24px] tracking-[0.3em] placeholder:text-text-faint"
								placeholder="123456"
							/>
						</label>
						<button
							type="submit"
							disabled={busy !== null || code.length !== 6}
							aria-busy={busy === "verify"}
							className="btn btn-primary btn-block mt-4"
						>
							{busy === "verify" ? t("stepUp.verifying") : t("stepUp.confirm")}
						</button>
						{resendSeconds > 0 ? (
							<p className="mt-3 text-center text-[12px] tabular-nums text-text-faint">
								{t("stepUp.resendIn", { seconds: resendSeconds })}
							</p>
						) : (
							<button
								type="button"
								onClick={() => void requestCode()}
								disabled={busy !== null}
								className="btn-text mt-2 w-full"
							>
								{t("stepUp.resend")}
							</button>
						)}
					</form>
				) : (
					<button
						type="button"
						onClick={() => void requestCode()}
						disabled={busy !== null}
						aria-busy={busy === "request"}
						data-dialog-initial-focus="true"
						className="btn btn-primary btn-block mt-5"
					>
						{busy === "request" ? t("stepUp.sending") : t("stepUp.send")}
					</button>
				)}

				{error ? (
					<p id="step-up-error" role="alert" className="mt-3 text-center text-[13px] leading-relaxed text-danger">
						{error}
					</p>
				) : null}
				<button
					type="button"
					onClick={onCancel}
					disabled={busy !== null}
					className="btn-text mt-2 w-full"
				>
					{t("common.cancel")}
				</button>
			</div>
		</div>,
		document.body,
	);
}

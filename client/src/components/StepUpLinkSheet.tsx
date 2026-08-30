import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDialog } from "../hooks/useDialog";
import { apiFetch } from "../lib/api";
import { rememberEmailLinkRequest, type User } from "../lib/firebase";
import { humanizeError } from "../lib/notify";
import type { RecoveryStepUpAction } from "../lib/recoveryStepUp";

type LinkRequestResponse = {
	sent: true;
	maskedEmail: string;
	expiresInSeconds: number;
	resendAfterSeconds: number;
};

export default function StepUpLinkSheet({
	user,
	action,
	onCancel,
}: {
	user: User;
	action: RecoveryStepUpAction;
	onCancel: () => void;
}) {
	const { t, i18n } = useTranslation();
	const [sentTo, setSentTo] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [resendAt, setResendAt] = useState(0);
	const [clock, setClock] = useState(() => Date.now());
	const dialogRef = useDialog<HTMLDivElement>(() => {
		if (!busy) onCancel();
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

	async function requestLink() {
		setBusy(true);
		setError(null);
		try {
			const result = await apiFetch<LinkRequestResponse>("/auth/step-up/email-link/request", {
				user,
				body: {
					action,
					locale: i18n.resolvedLanguage?.startsWith("en") ? "en" : "es",
				},
			});
			if (user.email) rememberEmailLinkRequest(user.email, "recovery");
			setSentTo(result.maskedEmail);
			setClock(Date.now());
			setResendAt(Date.now() + result.resendAfterSeconds * 1_000);
		} catch (cause) {
			setError(humanizeError(cause, t("stepUp.sendError")).message);
		} finally {
			setBusy(false);
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
				<h2 id="step-up-title" className="font-display text-[24px] leading-tight">{t("stepUp.title")}</h2>
				<p id="step-up-description" className="mt-2 text-[13px] leading-relaxed text-text-muted">
					{sentTo ? t("stepUp.sentTo", { email: sentTo }) : t("stepUp.description")}
				</p>

				{sentTo ? (
					<>
						<p className="mt-4 text-[12px] leading-relaxed text-text-faint">{t("stepUp.linkSafety")}</p>
						{resendSeconds > 0 ? (
							<p className="mt-3 text-center text-[12px] tabular-nums text-text-faint">{t("stepUp.resendIn", { seconds: resendSeconds })}</p>
						) : (
							<button type="button" onClick={() => void requestLink()} disabled={busy} aria-busy={busy} className="btn-text mt-3 w-full">
								{busy ? t("stepUp.sending") : t("stepUp.resend")}
							</button>
						)}
					</>
				) : (
					<button type="button" onClick={() => void requestLink()} disabled={busy} aria-busy={busy} data-dialog-initial-focus="true" className="btn btn-primary btn-block mt-5">
						{busy ? t("stepUp.sending") : t("stepUp.send")}
					</button>
				)}

				{error ? <p id="step-up-error" role="alert" className="mt-3 text-center text-[13px] leading-relaxed text-danger">{error}</p> : null}
				<button type="button" onClick={onCancel} disabled={busy} className="btn-text mt-2 w-full">
					{sentTo ? t("common.close") : t("common.cancel")}
				</button>
			</div>
		</div>,
		document.body,
	);
}

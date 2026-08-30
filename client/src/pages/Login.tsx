import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import BrandLockup from "../components/brand/BrandLockup";
import MeliSprite from "../components/brand/MeliSprite";
import Turnstile from "../components/Turnstile";
import { isTurnstileReady, type TurnstileState } from "../components/turnstileState";
import { apiFetch } from "../lib/api";
import {
	clearPendingEmailLinkRequest,
	completeFirebaseEmailLink,
	emailLinkFlow,
	isFirebaseEmailLink,
	pendingEmailLinkRequest,
	rememberEmailLinkRequest,
	signInWithGoogle,
} from "../lib/firebase";
import { humanizeError, isUserCancelled } from "../lib/notify";
import { storeRecoveryStepUp } from "../lib/recoveryStepUp";
import { writeStorage } from "../lib/storageMigration";

const RECOVER_INTENT_KEY = "gatopago:recover-intent";

type Mode = "buttons" | "email" | "sent" | "completing" | "need-email";
type BusyAction = "google" | "request" | "resend" | "complete" | null;

type LinkRequestResponse = { sent: true; resendAfterSeconds: number };
type RecoveryExchangeResponse = {
	stepUpToken: string;
	action: "start" | "execute";
	expiresInSeconds: number;
};

function GoogleIcon() {
	return (
		<svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
			<path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62Z" />
			<path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.34-1.58-5.05-3.71H.96v2.33A9 9 0 0 0 9 18Z" />
			<path fill="#FBBC05" d="M3.95 10.71a5.4 5.4 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l2.99-2.33Z" />
			<path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.96l2.99 2.33C4.66 5.16 6.65 3.58 9 3.58Z" />
		</svg>
	);
}

function MailIcon() {
	return (
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
			<rect x="3" y="5" width="18" height="14" rx="2" />
			<path d="m3 7 9 6 9-6" />
		</svg>
	);
}

function validEmail(value: string): boolean {
	return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value) && value.length <= 254;
}

export default function Login() {
	const { t, i18n } = useTranslation();
	const [landingUrl] = useState(() => window.location.href);
	const [linkLanding] = useState(() => isFirebaseEmailLink(landingUrl));
	const [linkContext] = useState(() => emailLinkFlow(landingUrl));
	const [initialRequest] = useState(() => pendingEmailLinkRequest());
	const storedEmail = initialRequest?.purpose === linkContext.flow ? initialRequest.email : "";
	const [mode, setMode] = useState<Mode>(() => (
		linkLanding ? (storedEmail ? "completing" : "need-email") : "buttons"
	));
	const [email, setEmail] = useState(storedEmail);
	const [busy, setBusy] = useState<BusyAction>(null);
	const [inlineError, setInlineError] = useState<string | null>(null);
	const [recoverIntent, setRecoverIntent] = useState(false);
	const [resendAt, setResendAt] = useState(0);
	const [clock, setClock] = useState(() => Date.now());
	const [challengeRevision, setChallengeRevision] = useState(0);
	const [turnstile, setTurnstile] = useState<TurnstileState>({ status: "loading", token: null });

	useEffect(() => {
		if (mode !== "sent" || resendAt <= Date.now()) return;
		const timer = window.setInterval(() => {
			const next = Date.now();
			setClock(next);
			if (next >= resendAt) window.clearInterval(timer);
		}, 1_000);
		return () => window.clearInterval(timer);
	}, [mode, resendAt]);

	const displayError = useCallback((error: unknown, fallback: string) => {
		setInlineError(humanizeError(error, fallback).message);
	}, []);

	function resetChallenge() {
		setTurnstile({ status: "loading", token: null });
		setChallengeRevision((value) => value + 1);
	}

	const completeLink = useCallback(async (candidateEmail: string) => {
		const normalizedEmail = candidateEmail.trim().toLowerCase();
		if (!validEmail(normalizedEmail)) {
			setInlineError(t("login.invalidEmail"));
			setMode("need-email");
			return;
		}
		setEmail(normalizedEmail);
		setInlineError(null);
		setBusy("complete");
		setMode("completing");
		try {
			const credential = await completeFirebaseEmailLink(
				landingUrl,
				normalizedEmail,
				linkContext.flow,
			);
			if (linkContext.flow === "recovery") {
				if (!linkContext.challenge || !/^[A-Za-z0-9_-]{43}$/.test(linkContext.challenge)) {
					throw new Error(t("login.invalidLink"));
				}
				const proof = await apiFetch<RecoveryExchangeResponse>("/auth/step-up/email-link/exchange", {
					user: credential.user,
					body: { challenge: linkContext.challenge },
				});
				storeRecoveryStepUp(proof);
				clearPendingEmailLinkRequest();
				window.location.replace("/recover");
				return;
			}
			clearPendingEmailLinkRequest();
			window.location.replace("/");
		} catch (error) {
			displayError(error, t("login.completeError"));
			setMode("need-email");
		} finally {
			setBusy(null);
		}
	}, [displayError, landingUrl, linkContext, t]);

	useEffect(() => {
		if (!linkLanding || mode !== "completing" || !storedEmail) return;
		let cancelled = false;
		queueMicrotask(() => {
			if (!cancelled) void completeLink(storedEmail);
		});
		return () => {
			cancelled = true;
		};
	}, [completeLink, linkLanding, mode, storedEmail]);

	const resendSeconds = Math.max(0, Math.ceil((resendAt - clock) / 1_000));

	async function handleGoogle() {
		setInlineError(null);
		setBusy("google");
		try {
			const credential = await signInWithGoogle();
			if (credential) await credential.user.getIdToken(true);
		} catch (error) {
			if (!isUserCancelled(error)) displayError(error, t("login.signInError"));
		} finally {
			setBusy(null);
		}
	}

	async function requestLink(action: "request" | "resend") {
		const normalizedEmail = email.trim().toLowerCase();
		if (!validEmail(normalizedEmail)) {
			setInlineError(t("login.invalidEmail"));
			return;
		}
		if (!isTurnstileReady(turnstile)) return;
		setInlineError(null);
		setBusy(action);
		try {
			const result = await apiFetch<LinkRequestResponse>("/auth/email-link/request", {
				body: {
					email: normalizedEmail,
					locale: i18n.resolvedLanguage?.startsWith("en") ? "en" : "es",
					turnstileToken: turnstile.token,
				},
			});
			rememberEmailLinkRequest(normalizedEmail, "signin");
			setEmail(normalizedEmail);
			setClock(Date.now());
			setResendAt(Date.now() + result.resendAfterSeconds * 1_000);
			setMode("sent");
			resetChallenge();
		} catch (error) {
			displayError(error, t("login.sendError"));
			resetChallenge();
		} finally {
			setBusy(null);
		}
	}

	function openEmailMode() {
		setInlineError(null);
		setMode("email");
		resetChallenge();
	}

	const linkMode = mode === "sent" || mode === "completing" || mode === "need-email";

	return (
		<div className="app-frame mx-auto flex min-h-dvh w-full max-w-[480px] flex-col px-5">
			<header className="flex shrink-0 justify-center pt-[calc(env(safe-area-inset-top)+1.25rem)] animate-fade-in">
				<BrandLockup compact />
			</header>

			<main className="flex flex-1 flex-col items-center justify-center py-4 text-center animate-fade-up">
				<div className={`meli-login-stage mb-4 ${mode === "buttons" ? "min-h-[170px]" : "min-h-[112px]"}`}>
					<span aria-hidden="true" />
					<MeliSprite name={linkMode ? "body-peek-card" : "body-sitting"} motion="idle" className={mode === "buttons" ? "w-36 sm:w-40" : "w-24"} priority />
				</div>

				<h1 className="mb-2 max-w-[350px] text-pretty font-display text-[30px] leading-[1.05]">
					{mode === "sent" ? t("login.linkSentTitle") : mode === "completing" ? t("login.openingLink") : mode === "need-email" ? t("login.confirmEmailTitle") : t("login.title")}
				</h1>
				{mode === "buttons" ? (
					<>
						<p className="mb-2 max-w-[340px] font-display text-[18px] leading-tight text-text-muted">{t("login.heroLead")} <span className="text-cat-300">{t("login.heroEmphasis")}</span></p>
						<p className="max-w-[330px] text-[13px] leading-relaxed text-text-muted">{t("login.subtitle")}</p>
					</>
				) : mode === "sent" ? (
					<p className="max-w-[340px] text-[14px] leading-relaxed text-text-muted">{t("login.linkSentTo", { email })}</p>
				) : mode === "completing" ? (
					<p className="max-w-[330px] text-[14px] leading-relaxed text-text-muted">{t("login.openingLinkBody")}</p>
				) : mode === "need-email" ? (
					<p className="max-w-[340px] text-[14px] leading-relaxed text-text-muted">{t("login.confirmEmailBody")}</p>
				) : (
					<p className="max-w-[330px] text-[14px] leading-relaxed text-text-muted">{t("login.noPasswords")}</p>
				)}
			</main>

			<section className="flex flex-col items-center gap-3 animate-fade-up" style={{ paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))" }} aria-label={t("login.title")}>
				{mode === "email" ? (
					<form onSubmit={(event) => { event.preventDefault(); void requestLink("request"); }} className="flex w-full flex-col items-center gap-3">
						<label className="block w-full text-left text-[13px] text-text-muted">
							<span className="mb-2 block">{t("login.emailLabel")}</span>
							<input type="email" name="email" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t("login.emailPlaceholder")} aria-invalid={inlineError ? true : undefined} aria-describedby={inlineError ? "login-error" : undefined} className="meli-field text-[15px] placeholder:text-text-faint" />
						</label>
						<Turnstile key={challengeRevision} action="email_login" onStateChange={setTurnstile} />
						<button type="submit" disabled={busy !== null || !isTurnstileReady(turnstile)} aria-busy={busy === "request"} className="btn btn-primary btn-block">{busy === "request" ? t("login.sending") : t("login.sendLink")}</button>
						<button type="button" onClick={() => setMode("buttons")} className="btn-text">{t("common.back")}</button>
					</form>
				) : mode === "sent" ? (
					<div className="flex w-full flex-col items-center gap-3">
						<p className="max-w-[340px] text-[12px] leading-relaxed text-text-faint">{t("login.linkSafety")}</p>
						<div className="w-full"><Turnstile key={challengeRevision} action="email_login" onStateChange={setTurnstile} /></div>
						{resendSeconds > 0 ? (
							<p className="text-[12px] tabular-nums text-text-faint">{t("login.resendIn", { seconds: resendSeconds })}</p>
						) : (
							<button type="button" onClick={() => void requestLink("resend")} disabled={busy !== null || !isTurnstileReady(turnstile)} aria-busy={busy === "resend"} className="btn-text">{busy === "resend" ? t("login.sending") : t("login.resend")}</button>
						)}
						<button type="button" onClick={openEmailMode} className="btn-text">{t("login.changeEmail")}</button>
					</div>
				) : mode === "need-email" ? (
					<form onSubmit={(event) => { event.preventDefault(); void completeLink(email); }} className="flex w-full flex-col items-center gap-3">
						<label className="block w-full text-left text-[13px] text-text-muted">
							<span className="mb-2 block">{t("login.emailLabel")}</span>
							<input type="email" name="email-link-confirmation" inputMode="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t("login.emailPlaceholder")} autoFocus className="meli-field text-[15px] placeholder:text-text-faint" />
						</label>
						<button type="submit" disabled={busy !== null || !validEmail(email.trim())} aria-busy={busy === "complete"} className="btn btn-primary btn-block">{busy === "complete" ? t("login.openingLink") : t("login.confirmEmail")}</button>
						<button type="button" onClick={() => window.location.replace("/login")} disabled={busy !== null} className="btn-text">{t("common.back")}</button>
					</form>
				) : mode === "completing" ? (
					<div role="status" aria-live="polite" className="flex min-h-12 items-center justify-center">
						<span className="h-7 w-7 animate-spin rounded-full border-2 border-text-faint border-t-cat-500" aria-hidden="true" />
						<span className="sr-only">{t("login.openingLink")}</span>
					</div>
				) : (
					<>
						<button type="button" onClick={() => void handleGoogle()} disabled={busy !== null} aria-busy={busy === "google"} className="btn btn-primary btn-block"><GoogleIcon />{busy === "google" ? t("login.signingIn") : t("login.continueGoogle")}</button>
						<button type="button" onClick={openEmailMode} disabled={busy !== null} className="btn btn-ghost btn-block"><MailIcon />{t("login.continueEmail")}</button>
						<p className="mt-1 max-w-[340px] text-[12px] leading-relaxed text-text-faint">{t("login.identityNote")}</p>
						{recoverIntent ? (
							<p className="max-w-[300px] text-center text-[13px] leading-relaxed text-text-muted">{t("recover.loginHint")}</p>
						) : (
							<button type="button" onClick={() => { writeStorage(RECOVER_INTENT_KEY, "1"); setRecoverIntent(true); }} className="btn-text">{t("recover.loginLink")}</button>
						)}
					</>
				)}

				{inlineError ? <p id="login-error" role="alert" className="max-w-[340px] text-pretty text-[13px] leading-relaxed text-danger">{inlineError}</p> : null}
			</section>
		</div>
	);
}

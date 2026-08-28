import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import BrandLockup from "../components/brand/BrandLockup";
import MeliSprite from "../components/brand/MeliSprite";
import Turnstile from "../components/Turnstile";
import { isTurnstileReady, type TurnstileState } from "../components/turnstileState";
import { apiFetch } from "../lib/api";
import { signInWithEmailCodeToken, signInWithGoogle } from "../lib/firebase";
import { humanizeError, isUserCancelled } from "../lib/notify";
import { writeStorage } from "../lib/storageMigration";

const RECOVER_INTENT_KEY = "gatopago:recover-intent";

type Mode = "buttons" | "email" | "code";
type BusyAction = "google" | "request" | "verify" | "resend" | null;

type CodeRequestResponse = {
	sent: true;
	expiresInSeconds: number;
	resendAfterSeconds: number;
};

type CodeVerifyResponse = { customToken: string };

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
	const [mode, setMode] = useState<Mode>("buttons");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState<BusyAction>(null);
	const [inlineError, setInlineError] = useState<string | null>(null);
	const [recoverIntent, setRecoverIntent] = useState(false);
	const [resendAt, setResendAt] = useState(0);
	const [clock, setClock] = useState(() => Date.now());
	const [challengeRevision, setChallengeRevision] = useState(0);
	const [turnstile, setTurnstile] = useState<TurnstileState>({
		status: "loading",
		token: null,
	});

	useEffect(() => {
		if (mode !== "code" || resendAt <= Date.now()) return;
		const timer = window.setInterval(() => {
			const next = Date.now();
			setClock(next);
			if (next >= resendAt) window.clearInterval(timer);
		}, 1_000);
		return () => window.clearInterval(timer);
	}, [mode, resendAt]);

	const resendSeconds = Math.max(0, Math.ceil((resendAt - clock) / 1_000));

	function displayError(error: unknown, fallback: string) {
		setInlineError(humanizeError(error, fallback).message);
	}

	function resetChallenge() {
		setTurnstile({ status: "loading", token: null });
		setChallengeRevision((value) => value + 1);
	}

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

	async function requestCode(action: "request" | "resend") {
		const normalizedEmail = email.trim().toLowerCase();
		if (!validEmail(normalizedEmail)) {
			setInlineError(t("login.invalidEmail"));
			return;
		}
		if (!isTurnstileReady(turnstile)) return;
		setInlineError(null);
		setBusy(action);
		try {
			const result = await apiFetch<CodeRequestResponse>("/auth/email-code/request", {
				body: {
					email: normalizedEmail,
					locale: i18n.resolvedLanguage?.startsWith("en") ? "en" : "es",
					turnstileToken: turnstile.token,
				},
			});
			setEmail(normalizedEmail);
			setCode("");
			setClock(Date.now());
			setResendAt(Date.now() + result.resendAfterSeconds * 1_000);
			setMode("code");
			resetChallenge();
		} catch (error) {
			displayError(error, t("login.sendError"));
			resetChallenge();
		} finally {
			setBusy(null);
		}
	}

	async function verifyCode() {
		if (!/^\d{6}$/.test(code)) {
			setInlineError(t("login.invalidCode"));
			return;
		}
		setInlineError(null);
		setBusy("verify");
		try {
			const result = await apiFetch<CodeVerifyResponse>("/auth/email-code/verify", {
				body: { email, code },
			});
			await signInWithEmailCodeToken(result.customToken);
		} catch (error) {
			displayError(error, t("login.completeError"));
		} finally {
			setBusy(null);
		}
	}

	function openEmailMode() {
		setInlineError(null);
		setMode("email");
		resetChallenge();
	}

	return (
		<div className="app-frame mx-auto flex min-h-dvh w-full max-w-[480px] flex-col px-5">
			<header className="flex shrink-0 justify-center pt-[calc(env(safe-area-inset-top)+1.25rem)] animate-fade-in">
				<BrandLockup compact />
			</header>

			<main className="flex flex-1 flex-col items-center justify-center py-4 text-center animate-fade-up">
				<div className={`meli-login-stage mb-4 ${mode === "buttons" ? "min-h-[170px]" : "min-h-[112px]"}`}>
					<span aria-hidden="true" />
					<MeliSprite
						name={mode === "code" ? "body-peek-card" : "body-sitting"}
						motion="idle"
						className={mode === "buttons" ? "w-36 sm:w-40" : "w-24"}
						priority
					/>
				</div>

				<h1 className="mb-2 max-w-[350px] text-pretty font-display text-[30px] leading-[1.05]">
					{mode === "code" ? t("login.codeTitle") : t("login.title")}
				</h1>
				{mode === "buttons" ? (
					<>
						<p className="mb-2 max-w-[340px] font-display text-[18px] leading-tight text-text-muted">
							{t("login.heroLead")} <span className="text-cat-300">{t("login.heroEmphasis")}</span>
						</p>
						<p className="max-w-[330px] text-[13px] leading-relaxed text-text-muted">
							{t("login.subtitle")}
						</p>
					</>
				) : mode === "code" ? (
					<p className="max-w-[330px] text-[14px] leading-relaxed text-text-muted">
						{t("login.codeSentTo", { email })}
					</p>
				) : (
					<p className="max-w-[330px] text-[14px] leading-relaxed text-text-muted">
						{t("login.noPasswords")}
					</p>
				)}
			</main>

			<section
				className="flex flex-col items-center gap-3 animate-fade-up"
				style={{ paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))" }}
				aria-label={t("login.title")}
			>
				{mode === "email" ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void requestCode("request");
						}}
						className="flex w-full flex-col items-center gap-3"
					>
						<label className="block w-full text-left text-[13px] text-text-muted">
							<span className="mb-2 block">{t("login.emailLabel")}</span>
							<input
								type="email"
								name="email"
								inputMode="email"
								autoComplete="email"
								autoCapitalize="none"
								spellCheck={false}
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								placeholder={t("login.emailPlaceholder")}
								aria-invalid={inlineError ? true : undefined}
								aria-describedby={inlineError ? "login-error" : undefined}
								className="meli-field text-[15px] placeholder:text-text-faint"
							/>
						</label>
						<Turnstile key={challengeRevision} action="email_login" onStateChange={setTurnstile} />
						<button
							type="submit"
							disabled={busy !== null || !isTurnstileReady(turnstile)}
							aria-busy={busy === "request"}
							className="btn btn-primary btn-block"
						>
							{busy === "request" ? t("login.sending") : t("login.sendCode")}
						</button>
						<button type="button" onClick={() => setMode("buttons")} className="btn-text">
							{t("common.back")}
						</button>
					</form>
				) : mode === "code" ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void verifyCode();
						}}
						className="flex w-full flex-col items-center gap-3"
					>
						<label className="block w-full text-left text-[13px] text-text-muted">
							<span className="mb-2 block">{t("login.codeLabel")}</span>
							<input
								type="text"
								name="one-time-code"
								inputMode="numeric"
								autoComplete="one-time-code"
								autoCapitalize="none"
								spellCheck={false}
								pattern="[0-9]{6}"
								value={code}
								onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
								placeholder={t("login.codePlaceholder")}
								aria-invalid={inlineError ? true : undefined}
								aria-describedby={inlineError ? "login-error" : undefined}
								className="meli-field text-center font-display text-[24px] tracking-[0.3em] placeholder:text-text-faint"
							/>
						</label>
						<button
							type="submit"
							disabled={busy !== null || code.length !== 6}
							aria-busy={busy === "verify"}
							className="btn btn-primary btn-block"
						>
							{busy === "verify" ? t("login.verifying") : t("login.verifyCode")}
						</button>

						<div className="w-full">
							<Turnstile key={challengeRevision} action="email_login" onStateChange={setTurnstile} />
						</div>
						{resendSeconds > 0 ? (
							<p className="text-[12px] tabular-nums text-text-faint">
								{t("login.resendIn", { seconds: resendSeconds })}
							</p>
						) : (
							<button
								type="button"
								onClick={() => void requestCode("resend")}
								disabled={busy !== null || !isTurnstileReady(turnstile)}
								aria-busy={busy === "resend"}
								className="btn-text"
							>
								{busy === "resend" ? t("login.sending") : t("login.resend")}
							</button>
						)}
						<button type="button" onClick={openEmailMode} className="btn-text">
							{t("login.changeEmail")}
						</button>
					</form>
				) : (
					<>
						<button
							type="button"
							onClick={() => void handleGoogle()}
							disabled={busy !== null}
							aria-busy={busy === "google"}
							className="btn btn-primary btn-block"
						>
							<GoogleIcon />
							{busy === "google" ? t("login.signingIn") : t("login.continueGoogle")}
						</button>
						<button type="button" onClick={openEmailMode} disabled={busy !== null} className="btn btn-ghost btn-block">
							<MailIcon />
							{t("login.continueEmail")}
						</button>
						<p className="mt-1 max-w-[340px] text-[12px] leading-relaxed text-text-faint">
							{t("login.identityNote")}
						</p>
						{recoverIntent ? (
							<p className="max-w-[300px] text-center text-[13px] leading-relaxed text-text-muted">
								{t("recover.loginHint")}
							</p>
						) : (
							<button
								type="button"
								onClick={() => {
									try {
										writeStorage(RECOVER_INTENT_KEY, "1");
									} catch {
										/* storage unavailable */
									}
									setRecoverIntent(true);
								}}
								className="btn-text"
							>
								{t("recover.loginLink")}
							</button>
						)}
					</>
				)}

				{inlineError ? (
					<p id="login-error" role="alert" className="max-w-[340px] text-pretty text-[13px] leading-relaxed text-danger">
						{inlineError}
					</p>
				) : null}
			</section>
		</div>
	);
}

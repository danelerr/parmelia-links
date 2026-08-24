import { useState } from "react";
import Logo from "../components/Logo";
import Turnstile from "../components/Turnstile";
import { turnstileReady, type TurnstileState } from "../components/turnstileState";
import { requestEmailCode, verifyEmailCode } from "../lib/authApi";
import { signInWithEmailCodeToken, signInWithGoogle } from "../lib/firebase";

type Mode = "buttons" | "email" | "code";
type Busy = "google" | "send" | "verify" | null;

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

export default function Login() {
	const [mode, setMode] = useState<Mode>("buttons");
	const [email, setEmail] = useState("");
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState<Busy>(null);
	const [error, setError] = useState<string | null>(null);
	const [challengeRevision, setChallengeRevision] = useState(0);
	const [turnstile, setTurnstile] = useState<TurnstileState>({ status: "loading", token: null });

	function resetChallenge() {
		setTurnstile({ status: "loading", token: null });
		setChallengeRevision((value) => value + 1);
	}

	function openEmail() {
		setError(null);
		resetChallenge();
		setMode("email");
	}

	async function handleGoogle() {
		setError(null);
		setBusy("google");
		try {
			await signInWithGoogle();
		} catch {
			setError("No pudimos iniciar sesión. Intenta de nuevo.");
		} finally {
			setBusy(null);
		}
	}

	async function handleSend() {
		const normalized = email.trim().toLowerCase();
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized) || normalized.length > 254) {
			setError("Escribe un correo válido.");
			return;
		}
		if (!turnstileReady(turnstile)) return;
		const turnstileToken = turnstile.token;
		if (turnstileToken === null) return;
		setError(null);
		setBusy("send");
		try {
			await requestEmailCode({ email: normalized, turnstileToken });
			setEmail(normalized);
			setCode("");
			setMode("code");
		} catch (sendError) {
			setError(sendError instanceof Error ? sendError.message : "No pudimos enviar el código.");
			// Turnstile tokens are single-use even when the downstream request fails.
			resetChallenge();
		} finally {
			setBusy(null);
		}
	}

	async function handleVerify() {
		if (!/^\d{6}$/.test(code)) {
			setError("Escribe los 6 dígitos del código.");
			return;
		}
		setError(null);
		setBusy("verify");
		try {
			const result = await verifyEmailCode({ email, code });
			await signInWithEmailCodeToken(result.customToken);
		} catch (verifyError) {
			setError(verifyError instanceof Error ? verifyError.message : "No pudimos verificar el código.");
		} finally {
			setBusy(null);
		}
	}

	return (
		<div className="flex min-h-dvh items-center justify-center px-5">
			<div className="w-full max-w-[380px] text-center animate-fade-up">
				<Logo className="mx-auto mb-6 w-14" />
				<h1 className="mb-2 font-display text-[26px]">
					Panel de <span className="text-brand-gradient">negocios</span>
				</h1>
				<p className="mb-8 text-[14px] text-text-muted">
					Administra tus cobros: API keys, webhooks, pagos y eventos.
				</p>

				{mode === "buttons" ? (
					<div className="flex flex-col gap-3">
						<button type="button" onClick={() => void handleGoogle()} disabled={busy !== null} aria-busy={busy === "google"} className="btn btn-primary btn-block">
							<GoogleIcon /> {busy === "google" ? "Entrando…" : "Continuar con Google"}
						</button>
						<button type="button" onClick={openEmail} disabled={busy !== null} className="btn btn-ghost btn-block">
							Continuar con correo
						</button>
						<p className="mt-1 text-[12px] text-text-faint">Misma cuenta que tu app GatoPago.</p>
					</div>
				) : null}

				{mode === "email" ? (
					<form onSubmit={(event) => { event.preventDefault(); void handleSend(); }} className="flex flex-col gap-3">
						<label className="text-left text-[13px] text-text-muted">
							<span className="mb-2 block">Correo electrónico</span>
							<input
								className="field text-center"
								type="email"
								name="email"
								inputMode="email"
								autoComplete="email"
								autoCapitalize="none"
								spellCheck={false}
								value={email}
								onChange={(event) => setEmail(event.target.value)}
								placeholder="tu@correo.com"
							/>
						</label>
						<Turnstile key={challengeRevision} onStateChange={setTurnstile} />
						<button type="submit" disabled={busy !== null || !turnstileReady(turnstile)} aria-busy={busy === "send"} className="btn btn-primary btn-block">
							{busy === "send" ? "Enviando…" : "Enviarme un código"}
						</button>
						<button type="button" onClick={() => setMode("buttons")} className="btn-text">Volver</button>
					</form>
				) : null}

				{mode === "code" ? (
					<form onSubmit={(event) => { event.preventDefault(); void handleVerify(); }} className="flex flex-col gap-3">
						<p className="text-[13px] leading-relaxed text-text-muted">
							Enviamos un código de 6 dígitos a <span className="text-text">{email}</span>.
						</p>
						<label className="text-left text-[13px] text-text-muted">
							<span className="mb-2 block">Código de 6 dígitos</span>
							<input
								className="field text-center font-display text-[20px] tracking-[0.3em]"
								type="text"
								name="one-time-code"
								inputMode="numeric"
								autoComplete="one-time-code"
								autoCapitalize="none"
								spellCheck={false}
								pattern="[0-9]{6}"
								value={code}
								onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
								placeholder="123456"
							/>
						</label>
						<button type="submit" disabled={busy !== null || code.length !== 6} aria-busy={busy === "verify"} className="btn btn-primary btn-block">
							{busy === "verify" ? "Verificando…" : "Verificar y entrar"}
						</button>
						<button type="button" onClick={openEmail} className="btn-text">Enviar otro código o cambiar correo</button>
					</form>
				) : null}

				{error ? <p role="alert" className="mt-4 text-[13px] leading-relaxed text-danger">{error}</p> : null}
			</div>
		</div>
	);
}

import { useEffect, useState } from "react";
import { sileo } from "sileo";
import {
	completeEmailLink,
	isEmailSignInLink,
	sendEmailLink,
	signInWithGoogle,
} from "../lib/firebase";
import Logo from "../components/Logo";

type Mode = "buttons" | "email" | "sent" | "completing" | "need-email";

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
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (!isEmailSignInLink(window.location.href)) return;
		setMode("completing");
		completeEmailLink(window.location.href)
			.then(() => window.history.replaceState({}, "", "/"))
			.catch((err) => {
				if (err instanceof Error && err.message === "NEED_EMAIL") setMode("need-email");
				else {
					sileo.error({ title: "No pudimos completar el inicio de sesión" });
					setMode("buttons");
				}
			});
	}, []);

	async function handleGoogle() {
		try {
			await signInWithGoogle();
		} catch {
			sileo.error({ title: "No pudimos iniciar sesión" });
		}
	}

	async function handleSend() {
		const value = email.trim().toLowerCase();
		if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) {
			sileo.error({ title: "Escribe un correo válido" });
			return;
		}
		setBusy(true);
		try {
			await sendEmailLink(value);
			setMode("sent");
		} catch {
			sileo.error({ title: "No pudimos enviar el enlace" });
		} finally {
			setBusy(false);
		}
	}

	async function handleComplete() {
		setBusy(true);
		try {
			await completeEmailLink(window.location.href, email.trim().toLowerCase());
			window.history.replaceState({}, "", "/");
		} catch {
			sileo.error({ title: "No pudimos completar el inicio de sesión" });
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="min-h-dvh flex items-center justify-center px-5">
			<div className="w-full max-w-[380px] text-center animate-fade-up">
				<Logo className="w-14 mx-auto mb-6" />
				<h1 className="font-display text-[26px] mb-2">
					Panel de <span className="text-brand-gradient">negocios</span>
				</h1>
				<p className="text-[14px] text-text-muted mb-8">
					Administra tus cobros: API keys, webhooks, pagos y eventos.
				</p>

				{mode === "completing" && <p className="text-[14px] text-text-muted">Iniciando sesión…</p>}

				{mode === "sent" && (
					<div className="card p-6">
						<p className="text-[15px] mb-1">Revisa tu correo</p>
						<p className="text-[13px] text-text-muted leading-relaxed">
							Enviamos un enlace de acceso a <span className="text-text">{email}</span>. Ábrelo en este
							dispositivo.
						</p>
						<button onClick={() => setMode("buttons")} className="btn-text mt-3">Usar otro método</button>
					</div>
				)}

				{mode === "need-email" && (
					<div className="flex flex-col gap-3">
						<p className="text-[13px] text-text-muted">Confirma el correo al que enviamos el enlace.</p>
						<input className="field text-center" type="email" inputMode="email" autoFocus value={email}
							onChange={(e) => setEmail(e.target.value)} placeholder="tu@correo.com" />
						<button onClick={handleComplete} disabled={busy} className="btn btn-primary btn-block">
							{busy ? "Entrando…" : "Entrar"}
						</button>
					</div>
				)}

				{mode === "buttons" && (
					<div className="flex flex-col gap-3">
						<button onClick={handleGoogle} className="btn btn-primary btn-block">
							<GoogleIcon /> Continuar con Google
						</button>
						<button onClick={() => setMode("email")} className="btn btn-ghost btn-block">
							Continuar con correo
						</button>
						<p className="text-[12px] text-text-faint mt-1">Misma cuenta que tu app Parmelia.</p>
					</div>
				)}

				{mode === "email" && (
					<div className="flex flex-col gap-3">
						<input className="field text-center" type="email" inputMode="email" autoFocus value={email}
							onChange={(e) => setEmail(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && handleSend()} placeholder="tu@correo.com" />
						<button onClick={handleSend} disabled={busy} className="btn btn-primary btn-block">
							{busy ? "Enviando…" : "Enviarme un enlace"}
						</button>
						<button onClick={() => setMode("buttons")} className="btn-text">Volver</button>
					</div>
				)}
			</div>
		</div>
	);
}

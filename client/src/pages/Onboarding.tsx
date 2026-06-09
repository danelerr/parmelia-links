import { useState } from "react";
import { sileo } from "sileo";
import { useViewTransitionNavigate } from "../useNav";
import { type User, logOut } from "../firebase";
import { fetchWithAuth } from "../authFetch";
import { createPasskey } from "../webauthn";
import Logo from "../components/Logo";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";

function Reassurance({ children }: { children: string }) {
	return (
		<div className="flex items-center gap-3 text-left">
			<span className="w-7 h-7 rounded-full bg-sky/15 flex items-center justify-center shrink-0">
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#9ce3f4" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
					<polyline points="20 6 9 17 4 12" />
				</svg>
			</span>
			<span className="text-[14px] text-text-muted">{children}</span>
		</div>
	);
}

export default function Onboarding({
	user,
	onComplete,
}: {
	user: User;
	onComplete: () => void;
}) {
	const navigate = useViewTransitionNavigate();
	const [creatingWallet, setCreatingWallet] = useState(false);

	async function handleCreateWallet() {
		setCreatingWallet(true);
		try {
			const uid = user.uid || "parmelia-user";
			const { credentialId, qx, qy } = await createPasskey(uid);

			const res = await fetchWithAuth(user, `${SERVER_URL}/account/create`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ credentialId, qx, qy }),
			});
			if (!res.ok) {
				const errorData = await res.json().catch(() => ({ error: "No se pudo crear tu cuenta" }));
				throw new Error(errorData.error || "No se pudo crear tu cuenta");
			}
			await res.json();

			sileo.success({
				title: "¡Cuenta lista!",
				description: "Recibiste 5 dólares digitales de bienvenida.",
			});
			onComplete();
			navigate("/");
		} catch (err) {
			sileo.error({
				title: "No se pudo crear tu cuenta",
				description: err instanceof Error ? err.message : "Intenta de nuevo",
			});
		} finally {
			setCreatingWallet(false);
		}
	}

	const firstName = user.displayName ? user.displayName.split(" ")[0] : null;

	return (
		<div className="flex flex-col min-h-dvh px-6 w-full max-w-[460px] mx-auto">
			<div className="flex-1 flex flex-col items-center justify-center text-center animate-fade-up">
				<Logo className="w-20 mb-8 animate-float-glow" />

				<h1 className="font-display text-[28px] leading-tight mb-3">
					Casi listo
					{firstName ? (
						<>
							, <span className="text-brand-gradient">{firstName}</span>
						</>
					) : null}
				</h1>
				<p className="text-text-muted text-[15px] leading-relaxed max-w-[300px] mb-8">
					Vamos a crear tu cuenta. Tu huella será tu llave — sin contraseñas, sin
					frases raras.
				</p>

				<div className="w-full max-w-[300px] bg-surface border border-border rounded-[18px] p-5 flex flex-col gap-3.5 shadow-e1">
					<Reassurance>Tu dinero siempre es tuyo</Reassurance>
					<Reassurance>Confirmas cada pago con tu huella</Reassurance>
					<Reassurance>Sin comisiones de red</Reassurance>
				</div>
			</div>

			<div
				className="flex flex-col items-center gap-4 animate-fade-up"
				style={{ paddingBottom: "max(2.5rem, env(safe-area-inset-bottom))" }}
			>
				<button
					onClick={handleCreateWallet}
					disabled={creatingWallet}
					className="btn btn-primary btn-block"
				>
					{creatingWallet ? "Creando tu cuenta…" : "Crear mi cuenta"}
				</button>
				<button
					onClick={logOut}
					className="text-[13px] text-text-faint hover:text-text-muted transition-colors"
				>
					Hoy no, gracias
				</button>
			</div>
		</div>
	);
}

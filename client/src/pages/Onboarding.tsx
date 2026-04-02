import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { sileo } from "sileo";
import { type User, logOut } from "../firebase";
import { fetchWithAuth } from "../authFetch";
import { createPasskey } from "../webauthn";
import Logo from "../components/Logo";
import { activeNetwork } from "../network";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";

export default function Onboarding({ user, onComplete }: { user: User, onComplete: () => void }) {
	const navigate = useNavigate();
	const [creatingWallet, setCreatingWallet] = useState(false);

	async function handleCreateWallet() {
		setCreatingWallet(true);
		try {
			// 1. Create passkey on the device (biometric prompt)
			const uid = user.uid || "parmelia-user";
			const { credentialId, qx, qy } = await createPasskey(uid);

			// 2. Send public key to server to deploy the smart account
			const res = await fetchWithAuth(user, `${SERVER_URL}/account/create`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ credentialId, qx, qy }),
			});
			if (!res.ok) {
				const errorData = await res.json().catch(() => ({ error: "Error al crear wallet" }));
				throw new Error(errorData.error || "Error al crear wallet");
			}
			await res.json();

			sileo.success({ title: "Wallet creada", description: "¡Recibiste 5 USDC de bienvenida!" });

			// Notify App.tsx that the wallet is ready, allowing access to Home
			onComplete();
			navigate("/");
		} catch (err) {
			sileo.error({ title: "Error", description: err instanceof Error ? err.message : "Error al crear wallet" });
		} finally {
			setCreatingWallet(false);
		}
	}
	return (
		<div className="flex flex-col min-h-dvh px-5 sm:px-8 py-10 relative w-full max-w-lg mx-auto bg-background">
			<div className="flex-1 flex flex-col items-center justify-center animate-fade-in">
				<Logo className="w-20 mb-10" />

				<h1 className="text-2xl font-semibold mb-3 text-center">
					Casi listo, <span className="text-parmelia-gold">{user.displayName ? user.displayName.split(" ")[0] : "Usuario"}</span>
				</h1>

				<div className="text-muted text-center mb-10 text-sm leading-relaxed max-w-xs space-y-4">
					<p>Para continuar debes crear tu wallet en {activeNetwork.name}</p>

					<p className="text-xs opacity-80">
						Se creará tu primera passkey y luego podrás agregar más desde Configuración sin cambiar de dirección.
					</p>

					<p className="text-xs opacity-80">
						También quedará lista la protección de recovery con guardian y ventana de 48 horas.
					</p>
				</div>


				<button
					onClick={handleCreateWallet}
					disabled={creatingWallet}
					className="w-full bg-parmelia-blue text-black py-4 rounded-xl font-medium text-sm transition-opacity disabled:opacity-50 active:scale-[0.98]"
				>
					{creatingWallet ? "Creando Smart Wallet..." : "Crear Billetera Inteligente"}
				</button>

				<button
					onClick={logOut}
					className="mt-6 text-xs text-muted hover:text-white transition-colors underline underline-offset-4"
				>
					Hoy no, gracias (cerrar sesion)
				</button>
			</div>
		</div>
	);
}

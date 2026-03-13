import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { sileo } from "sileo";
import type { User } from "../firebase";
import { fetchWithAuth } from "../authFetch";
import { createPasskey } from "../webauthn";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";
const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.vercel.app";

export default function Settings({ user }: { user: User }) {
	const navigate = useNavigate();
	const [username, setUsername] = useState("");
	const [currentUsername, setCurrentUsername] = useState<string | null>(null);
	const [walletAddress, setWalletAddress] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [copied, setCopied] = useState(false);
	const [hasStoredCredential, setHasStoredCredential] = useState<boolean | null>(null);
	const [updatingPasskey, setUpdatingPasskey] = useState(false);
	const [faucetClaimed, setFaucetClaimed] = useState<boolean | null>(null);
	const [claimingFaucet, setClaimingFaucet] = useState(false);

	useEffect(() => {
		async function fetchProfile() {
			try {
				const res = await fetchWithAuth(user, `${SERVER_URL}/user/profile`);
				if (res.ok) {
					const data = await res.json();
					setCurrentUsername(data.username || null);
					setUsername(data.username || "");
					setWalletAddress(data.walletAddress || null);
				}
			} catch {
				// No profile yet
			}
		}

		async function fetchPasskeyStatus() {
			try {
				const res = await fetchWithAuth(user, `${SERVER_URL}/account/passkey`);
				if (res.ok) {
					const data = await res.json();
					setHasStoredCredential(Boolean(data.hasStoredCredential));
				}
			} catch {
				// ignore
			}
		}

		async function fetchFaucetStatus() {
			try {
				const res = await fetchWithAuth(user, `${SERVER_URL}/account/fund`);
				if (res.ok) {
					const data = await res.json();
					setFaucetClaimed(data.funded);
				}
			} catch {
				// ignore
			}
		}

		fetchProfile();
		fetchPasskeyStatus();
		fetchFaucetStatus();
	}, [user]);

	async function handleSaveUsername() {
		if (!username.trim()) return;
		setSaving(true);
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/user/username`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ username: username.trim().toLowerCase() }),
			});
			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error || "Error al guardar");
			}
			setCurrentUsername(username.trim().toLowerCase());
			sileo.success({ title: "Guardado" });
		} catch (err) {
			sileo.error({ title: "Error", description: err instanceof Error ? err.message : "Error" });
		} finally {
			setSaving(false);
		}
	}

	async function handleUpdatePasskey() {
		setUpdatingPasskey(true);
		try {
			const uid = user.uid || "parmelia-user";
			const { credentialId, qx, qy } = await createPasskey(uid);

			const res = await fetchWithAuth(user, `${SERVER_URL}/account/passkey`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ credentialId, qx, qy }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({ error: "Error al actualizar passkey" }));
				throw new Error(data.error || "Error al actualizar passkey");
			}

			const data = await res.json();
			setHasStoredCredential(true);
			if (data.newWalletAddress) {
				setWalletAddress(data.newWalletAddress);
			}

			if (data.walletChanged && data.newWalletAddress) {
				sileo.success({
					title: "Passkey restablecida",
					description: "Se creo una nueva wallet para esta cuenta legacy.",
				});
			} else {
				sileo.success({ title: "Passkey restablecida" });
			}
		} catch (err) {
			sileo.error({
				title: "Error",
				description: err instanceof Error ? err.message : "Error al actualizar passkey",
			});
		} finally {
			setUpdatingPasskey(false);
		}
	}

	async function handleClaimFaucet() {
		setClaimingFaucet(true);
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/account/fund`, {
				method: "POST",
			});
			const data = await res.json();
			if (!res.ok) {
				if (data.alreadyFunded) {
					setFaucetClaimed(true);
					sileo.warning({ title: "Ya canjeado", description: "Ya recibiste tus 5 USDC de prueba" });
					return;
				}
				throw new Error(data.error || "Error al obtener USDC");
			}
			setFaucetClaimed(true);
			sileo.success({ title: "5 USDC recibidos", description: "Ya puedes probar pagos" });
		} catch (err) {
			sileo.error({ title: "Error", description: err instanceof Error ? err.message : "Error al obtener USDC" });
		} finally {
			setClaimingFaucet(false);
		}
	}

	return (
		<div className="flex flex-col min-h-dvh px-5 sm:px-8 pt-6 sm:pt-10 pb-12 w-full max-w-lg mx-auto">
			<div className="flex items-center justify-between mb-6">
				<button
					onClick={() => navigate("/")}
					className="flex items-center gap-1.5 text-sm text-muted hover:text-white transition-colors"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M19 12H5" />
						<path d="M12 19l-7-7 7-7" />
					</svg>
					Volver
				</button>
			</div>

			<h2 className="text-2xl mb-8">Configuración</h2>

			<div className="bg-surface rounded-2xl p-5 sm:p-6 mb-4 flex items-center gap-4">
				{user.photoURL ? (
					<img
						src={user.photoURL}
						alt=""
						referrerPolicy="no-referrer"
						className="w-14 h-14 rounded-full object-cover"
					/>
				) : (
					<div className="w-14 h-14 rounded-full bg-parmelia-blue/20 flex items-center justify-center text-xl font-bold text-parmelia-blue">
						{(user.displayName || user.email || "?")[0].toUpperCase()}
					</div>
				)}
				<div className="min-w-0">
					{user.displayName && <p className="text-sm font-medium truncate">{user.displayName}</p>}
					{user.email && <p className="text-xs text-muted truncate">{user.email}</p>}
				</div>
			</div>

			<div className="bg-surface rounded-2xl p-5 sm:p-6 mb-4">
				<label className="text-sm text-muted mb-2 block">Nombre de usuario</label>
				{currentUsername && (
					<p className="text-xs text-muted mb-3">{new URL(APP_URL).host}/{currentUsername}</p>
				)}
				<input
					type="text"
					placeholder="ej: daniel"
					value={username}
					onChange={(e) => setUsername(e.target.value.replace(/[^a-z0-9_-]/gi, "").toLowerCase())}
					maxLength={30}
					className="w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm mb-4"
				/>
				<button
					onClick={handleSaveUsername}
					disabled={saving}
					className="bg-parmelia-blue text-black px-8 py-2.5 rounded-full text-sm font-medium disabled:opacity-50 transition-opacity"
				>
					{saving ? "Guardando..." : "Guardar"}
				</button>
			</div>

			{walletAddress && (
				<div className="bg-surface rounded-2xl p-5 sm:p-6 mb-4">
					<label className="text-sm text-muted mb-2 block">Wallet</label>
					<p className="text-xs text-muted font-mono break-all leading-relaxed mb-3">{walletAddress}</p>
					<button
						onClick={() => {
							navigator.clipboard.writeText(walletAddress);
							sileo.success({ title: "Direccion copiada" });
							setCopied(true);
							setTimeout(() => setCopied(false), 2000);
						}}
						className="bg-parmelia-gold text-black px-6 py-2 rounded-full text-xs font-medium"
					>
						{copied ? "Copiado" : "Copiar direccion"}
					</button>
				</div>
			)}

			{walletAddress && (
				<div className="bg-surface rounded-2xl p-5 sm:p-6 mb-4">
					<label className="text-sm text-muted mb-2 block">Passkey</label>
					{hasStoredCredential === null ? (
						<p className="text-xs text-muted">Cargando...</p>
					) : (
						<>
							<p className="text-xs text-muted mb-3 leading-relaxed">
								Parmelia usa la passkey de tu dispositivo para firmar pagos. Cambiar de dispositivo no deberia cambiar tu wallet si la misma passkey esta sincronizada.
							</p>
							<p className="text-xs text-muted mb-3 leading-relaxed">
								En Android y Chrome normalmente se recupera desde Google Password Manager. En Apple normalmente se recupera desde iCloud Keychain.
							</p>
							{hasStoredCredential ? (
								<p className="text-xs text-parmelia-blue mb-3 leading-relaxed">
									Tenemos una referencia reciente de tu passkey. Al firmar, la app intentara primero usar la passkey asociada a esta cuenta para evitar mezclar passkeys de otras cuentas sincronizadas.
								</p>
							) : (
								<p className="text-xs text-parmelia-pink mb-3 leading-relaxed">
									No hay un credentialId reciente guardado en el servidor. Solo en ese caso la app intentara descubrir una passkey compatible. Si esta wallet es legacy y nunca tuvo passkey, necesitara migracion manual.
								</p>
							)}
							<p className="text-xs text-parmelia-pink mb-3 leading-relaxed">
								Boton temporal habilitado para restauracion manual. Este proceso puede cambiar la direccion de la wallet, incluso si la cuenta ya tenia passkey.
							</p>
							<button
								onClick={handleUpdatePasskey}
								disabled={updatingPasskey}
								className="bg-parmelia-blue text-black px-6 py-2 rounded-full text-xs font-medium disabled:opacity-50 transition-opacity mb-3"
							>
								{updatingPasskey ? "Restableciendo..." : "Restablecer passkey temporalmente"}
							</button>
							<p className="text-xs text-muted leading-relaxed">
								La opcion de restablecer passkey fue deshabilitada como flujo general porque, con el contrato actual, podria cambiar la wallet y dejar fondos en la direccion anterior.
							</p>
						</>
					)}
				</div>
			)}

			{walletAddress && (
				<div className="bg-surface rounded-2xl p-5 sm:p-6 mb-4">
					<label className="text-sm text-muted mb-2 block">USDC de prueba</label>
					{faucetClaimed === null ? (
						<p className="text-xs text-muted">Cargando...</p>
					) : faucetClaimed ? (
						<p className="text-xs text-muted">Ya canjeaste tus 5 USDC de prueba</p>
					) : (
						<>
							<p className="text-xs text-muted mb-3">Obten 5 USDC gratis para probar la app</p>
							<button
								onClick={handleClaimFaucet}
								disabled={claimingFaucet}
								className="bg-parmelia-gold text-black px-6 py-2 rounded-full text-xs font-medium disabled:opacity-50 transition-opacity"
							>
								{claimingFaucet ? "Enviando..." : "Obtener 5 USDC gratis"}
							</button>
						</>
					)}
				</div>
			)}

			{walletAddress && (
				<div className="bg-surface rounded-2xl p-5 sm:p-6 mb-4">
					<label className="text-sm text-muted mb-2 block">Mas tokens de prueba</label>
					<p className="text-xs text-muted mb-3 leading-relaxed">
						Puedes obtener mas USDC de prueba desde el faucet de Circle. Selecciona <strong>Base Sepolia</strong> y pega tu wallet.
					</p>
					<a
						href="https://faucet.circle.com"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-block !text-black bg-parmelia-blue px-6 py-2 rounded-full text-xs font-medium"
					>
						Ir a faucet.circle.com
					</a>
				</div>
			)}
		</div>
	);
}


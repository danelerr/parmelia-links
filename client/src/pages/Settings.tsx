import { useEffect, useState } from "react";
import { hexToBytes } from "viem";
import { useNavigate } from "react-router-dom";
import { sileo } from "sileo";
import type { User } from "../firebase";
import { fetchWithAuth } from "../authFetch";
import {
	createPasskey,
	listRememberedPasskeys,
	signWithPasskey,
	type RememberedPasskey,
} from "../webauthn";
import { activeNetwork } from "../network";

const SERVER_URL =
	import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";
const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.me";

interface ProfileResponse {
	username?: string | null;
	walletAddress?: string | null;
}

interface PasskeyStatusResponse {
	hasStoredCredential: boolean;
	hasWallet: boolean;
	signerCount: number | null;
	threshold: number | null;
	guardian: string | null;
	recoveryPending: boolean | null;
	recoveryExecutableAfter: string | null;
}

function isZeroAddress(address: string | null | undefined) {
	return !address || /^0x0{40}$/i.test(address);
}

export default function Settings({ user }: { user: User }) {
	const navigate = useNavigate();
	const [username, setUsername] = useState("");
	const [currentUsername, setCurrentUsername] = useState<string | null>(null);
	const [walletAddress, setWalletAddress] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [copied, setCopied] = useState(false);
	const [passkeyStatus, setPasskeyStatus] =
		useState<PasskeyStatusResponse | null>(null);
	const [rememberedPasskeys, setRememberedPasskeys] = useState<
		RememberedPasskey[]
	>([]);
	const [updatingPasskey, setUpdatingPasskey] = useState(false);
	const [faucetClaimed, setFaucetClaimed] = useState<boolean | null>(null);
	const [claimingFaucet, setClaimingFaucet] = useState(false);
	const [initialLoading, setInitialLoading] = useState(true);

	async function fetchProfileData(): Promise<ProfileResponse | null> {
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/user/profile`);
			if (!res.ok) return null;
			return (await res.json()) as ProfileResponse;
		} catch {
			return null;
		}
	}

	async function fetchPasskeyStatusData(): Promise<PasskeyStatusResponse | null> {
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/account/passkey`);
			if (!res.ok) return null;
			return (await res.json()) as PasskeyStatusResponse;
		} catch {
			return null;
		}
	}

	async function fetchFaucetStatusData(): Promise<{
		funded: boolean;
	} | null> {
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/account/fund`);
			if (!res.ok) return null;
			return (await res.json()) as { funded: boolean };
		} catch {
			return null;
		}
	}

	async function refreshSettings() {
		const [profileData, passkeyData, faucetData] = await Promise.all([
			fetchProfileData(),
			fetchPasskeyStatusData(),
			fetchFaucetStatusData(),
		]);

		setCurrentUsername(profileData?.username || null);
		setUsername(profileData?.username || "");
		setWalletAddress(profileData?.walletAddress || null);
		setPasskeyStatus(passkeyData);
		setFaucetClaimed(faucetData?.funded ?? null);
		setRememberedPasskeys(listRememberedPasskeys());
	}

	useEffect(() => {
		let cancelled = false;

		async function loadSettings() {
			setInitialLoading(true);
			await refreshSettings();
			if (!cancelled) {
				setInitialLoading(false);
			}
		}

		void loadSettings();

		return () => {
			cancelled = true;
		};
	}, [user]);

	async function handleSaveUsername() {
		if (!username.trim()) return;
		setSaving(true);
		try {
			const normalizedUsername = username.trim().toLowerCase();
			const res = await fetchWithAuth(user, `${SERVER_URL}/user/username`, {
				method: "PUT",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ username: normalizedUsername }),
			});
			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error || "Error al guardar");
			}
			setCurrentUsername(normalizedUsername);
			sileo.success({ title: "Guardado" });
		} catch (err) {
			sileo.error({
				title: "Error",
				description: err instanceof Error ? err.message : "Error",
			});
		} finally {
			setSaving(false);
		}
	}

	async function handleAddPasskey() {
		setUpdatingPasskey(true);
		try {
			const uid = user.uid || "parmelia-user";
			const nextPasskey = await createPasskey(uid);

			const intentRes = await fetchWithAuth(user, `${SERVER_URL}/account/passkey`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(nextPasskey),
			});
			if (!intentRes.ok) {
				const data = await intentRes
					.json()
					.catch(() => ({ error: "Error al preparar la nueva passkey" }));
				throw new Error(data.error || "Error al preparar la nueva passkey");
			}

			const intentData = (await intentRes.json()) as {
				addSignerCalldata?: string;
			};
			if (!intentData.addSignerCalldata) {
				throw new Error("No recibimos el calldata para agregar la passkey.");
			}

			const prepareRes = await fetchWithAuth(
				user,
				`${SERVER_URL}/account/passkey/prepare`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ callData: intentData.addSignerCalldata }),
				},
			);
			if (!prepareRes.ok) {
				const data = await prepareRes
					.json()
					.catch(() => ({ error: "Error al preparar la operación" }));
				throw new Error(data.error || "Error al preparar la operación");
			}

			const { userOpHash, credentialId } = (await prepareRes.json()) as {
				userOpHash: string;
				credentialId?: string | null;
			};

			const assertion = await signWithPasskey(
				hexToBytes(userOpHash as `0x${string}`),
				credentialId,
			);
			const submitRes = await fetchWithAuth(user, `${SERVER_URL}/pay/submit`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					userOpHash,
					authenticatorData: assertion.authenticatorData,
					clientDataJSON: assertion.clientDataJSON,
					r: assertion.r,
					s: assertion.s,
					credentialId: assertion.credentialId,
					qx: assertion.qx,
					qy: assertion.qy,
				}),
			});
			if (!submitRes.ok) {
				const data = await submitRes
					.json()
					.catch(() => ({ error: "Error al activar la nueva passkey" }));
				throw new Error(data.error || "Error al activar la nueva passkey");
			}

			await refreshSettings();
			sileo.success({
				title: "Passkey agregada",
				description:
					"La nueva passkey ya firma en la misma wallet. La anterior sigue activa por ahora.",
			});
		} catch (err) {
			sileo.error({
				title: "Error",
				description:
					err instanceof Error
						? err.message
						: "Error al actualizar passkey",
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
					sileo.warning({
						title: "Ya canjeado",
						description: "Ya recibiste tus tokens de prueba",
					});
					return;
				}
				throw new Error(data.error || "Error al obtener tokens");
			}
			setFaucetClaimed(true);
			sileo.success({
				title: "Tokens recibidos",
				description: "Ya puedes probar pagos y links",
			});
		} catch (err) {
			sileo.error({
				title: "Error",
				description:
					err instanceof Error ? err.message : "Error al obtener tokens",
			});
		} finally {
			setClaimingFaucet(false);
		}
	}

	const recoveryDateLabel = passkeyStatus?.recoveryExecutableAfter
		? new Date(passkeyStatus.recoveryExecutableAfter).toLocaleString()
		: null;

	if (initialLoading) {
		return (
			<div className="flex flex-col min-h-dvh px-5 sm:px-8 pt-6 sm:pt-10 pb-12 w-full max-w-lg mx-auto">
				<div className="flex items-center justify-between mb-6">
					<button
						onClick={() => navigate("/")}
						className="flex items-center gap-1.5 text-sm text-muted hover:text-white transition-colors"
					>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M19 12H5" />
							<path d="M12 19l-7-7 7-7" />
						</svg>
						Volver
					</button>
				</div>

				<h2 className="text-2xl mb-8">Configuración</h2>

				<div className="bg-surface rounded-2xl p-8 sm:p-10 flex-1 flex flex-col items-center justify-center gap-4">
					<div className="w-8 h-8 border-2 border-surface-2 border-t-parmelia-blue rounded-full animate-spin"></div>
					<p className="text-sm text-muted text-center">
						Cargando configuración...
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col min-h-dvh px-5 sm:px-8 pt-6 sm:pt-10 pb-12 w-full max-w-lg mx-auto">
			<div className="flex items-center justify-between mb-6">
				<button
					onClick={() => navigate("/")}
					className="flex items-center gap-1.5 text-sm text-muted hover:text-white transition-colors"
				>
					<svg
						width="16"
						height="16"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
						strokeLinecap="round"
						strokeLinejoin="round"
					>
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
					{user.displayName && (
						<p className="text-sm font-medium truncate">{user.displayName}</p>
					)}
					{user.email && (
						<p className="text-xs text-muted truncate">{user.email}</p>
					)}
				</div>
			</div>

			<div className="bg-surface rounded-2xl p-5 sm:p-6 mb-4">
				<label className="text-sm text-muted mb-2 block">Nombre de usuario</label>
				{currentUsername && (
					<p className="text-xs text-muted mb-3">
						{new URL(APP_URL).host}/{currentUsername}
					</p>
				)}
				<input
					type="text"
					placeholder="ej: daniel"
					value={username}
					onChange={(e) =>
						setUsername(
							e.target.value.replace(/[^a-z0-9_-]/gi, "").toLowerCase(),
						)
					}
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
					<div className="flex items-center justify-between mb-2">
						<label className="text-sm text-muted">Wallet</label>
						<span className="text-[11px] px-2.5 py-1 rounded-full bg-white/8 text-white/70">{activeNetwork.name}</span>
					</div>
					<p className="text-xs text-muted font-mono break-all leading-relaxed mb-3">
						{walletAddress}
					</p>
					<div className="flex gap-2">
						<button
							onClick={() => {
								navigator.clipboard.writeText(walletAddress);
								sileo.success({ title: "Dirección copiada" });
								setCopied(true);
								setTimeout(() => setCopied(false), 2000);
							}}
							className="bg-parmelia-gold text-black px-5 py-2 rounded-full text-xs font-medium"
						>
							{copied ? "Copiado" : "Copiar"}
						</button>
						<a
							href={`${activeNetwork.explorerBaseUrl}/address/${walletAddress}`}
							target="_blank"
							rel="noopener noreferrer"
							className="bg-surface-2 text-white px-5 py-2 rounded-full text-xs font-medium hover:bg-white/15 transition-colors"
						>
							Ver en explorador ↗
						</a>
					</div>
				</div>
			)}

			{walletAddress && (
				<div className="bg-surface rounded-2xl p-5 sm:p-6 mb-4">
					<div className="flex items-center justify-between mb-4">
						<label className="text-sm text-muted">
							Passkeys y seguridad
						</label>
					</div>

					{!passkeyStatus ? (
						<div className="flex items-center gap-2">
							<div className="w-4 h-4 border-2 border-surface-2 border-t-parmelia-blue rounded-full animate-spin"></div>
							<p className="text-xs text-muted">Cargando...</p>
						</div>
					) : (
						<>
							{/* Account summary — compact grid */}
							<div className="grid grid-cols-3 gap-3 mb-4">
								<div className="bg-surface-2 rounded-xl p-3 text-center">
									<p className="text-lg font-mono text-parmelia-blue">{passkeyStatus.signerCount || 1}</p>
									<p className="text-[10px] text-muted mt-0.5">Passkeys</p>
								</div>
								<div className="bg-surface-2 rounded-xl p-3 text-center">
									<p className="text-lg font-mono text-white">{passkeyStatus.threshold || 1}</p>
									<p className="text-[10px] text-muted mt-0.5">Threshold</p>
								</div>
								<div className="bg-surface-2 rounded-xl p-3 text-center">
									<p className="text-lg">
										{isZeroAddress(passkeyStatus.guardian)
											? "—"
											: "✓"}
									</p>
									<p className="text-[10px] text-muted mt-0.5">Guardian</p>
								</div>
							</div>

							{passkeyStatus.recoveryPending && (
								<div className="bg-parmelia-pink/10 border border-parmelia-pink/20 rounded-xl p-3 mb-4">
									<p className="text-xs text-parmelia-pink leading-relaxed">
										⚠ Recuperación pendiente — ejecutable después de {recoveryDateLabel}.
									</p>
								</div>
							)}

							{rememberedPasskeys.length > 0 && (
								<div className="flex flex-wrap gap-1.5 mb-4">
									{rememberedPasskeys.map((passkey) => (
										<span
											key={passkey.credentialId}
											className="text-[10px] px-2 py-0.5 rounded-full bg-white/8 text-white/70 font-mono"
										>
											...{passkey.credentialId.slice(-8)}
										</span>
									))}
								</div>
							)}

							<button
								onClick={handleAddPasskey}
								disabled={updatingPasskey}
								className="bg-parmelia-blue text-black px-6 py-2.5 rounded-full text-xs font-medium disabled:opacity-50 transition-opacity"
							>
								{updatingPasskey ? "Agregando..." : "Agregar passkey"}
							</button>
						</>
					)}
				</div>
			)}

			{walletAddress && (
				<div className="bg-surface rounded-2xl p-5 sm:p-6 mb-4">
					<label className="text-sm text-muted mb-2 block">
						Tokens de prueba
					</label>
					{faucetClaimed === null ? (
						<p className="text-xs text-muted">Cargando...</p>
					) : faucetClaimed ? (
						<p className="text-xs text-muted">
							Ya canjeaste tus tokens de prueba en esta cuenta
						</p>
					) : (
						<>
							<p className="text-xs text-muted mb-3">
								Obtén tokens de prueba para seguir usando la app
							</p>
							<button
								onClick={handleClaimFaucet}
								disabled={claimingFaucet}
								className="bg-parmelia-gold text-black px-6 py-2 rounded-full text-xs font-medium disabled:opacity-50 transition-opacity"
							>
								{claimingFaucet ? "Enviando..." : "Obtener tokens"}
							</button>
						</>
					)}
				</div>
			)}

			{walletAddress && activeNetwork.faucetUrl && (
				<div className="bg-surface rounded-2xl p-5 sm:p-6 mb-4">
					<label className="text-sm text-muted mb-2 block">
						Más tokens de prueba
					</label>
					<p className="text-xs text-muted mb-3 leading-relaxed">
						Si el faucet de {activeNetwork.name} está disponible, puedes abrirlo
						y pegar tu wallet para seguir probando.
					</p>
					<a
						href={activeNetwork.faucetUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-block text-black! bg-parmelia-blue px-6 py-2 rounded-full text-xs font-medium"
					>
						Abrir {activeNetwork.faucetLabel}
					</a>
				</div>
			)}
		</div>
	);
}

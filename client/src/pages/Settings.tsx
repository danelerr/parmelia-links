import { useEffect, useState, type ReactNode } from "react";
import { sileo } from "sileo";
import { type User, logOut } from "../lib/firebase";
import { fetchWithAuth } from "../lib/authFetch";
import { createPasskey, signWithPasskey } from "../lib/webauthn";
import { activeNetwork } from "../lib/activeNetwork";
import { hexToBytes } from "../lib/hex";
import { useViewTransitionNavigate } from "../hooks/useNav";

const SERVER_URL =
	import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";
const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.me";

interface ProfileResponse {
	username?: string | null;
	walletAddress?: string | null;
}

interface PasskeyStatusResponse {
	signerCount: number | null;
	guardian: string | null;
	recoveryPending: boolean | null;
	recoveryExecutableAfter: string | null;
}

function isZeroAddress(address: string | null | undefined) {
	return !address || /^0x0{40}$/i.test(address);
}

function shortAddress(address: string) {
	return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A titled content block with a colored accent badge. */
function Section({
	title,
	icon,
	accent,
	children,
}: {
	title?: string;
	icon?: ReactNode;
	accent?: string;
	children: ReactNode;
}) {
	return (
		<div className="mb-6">
			{title && (
				<div className="flex items-center gap-2.5 px-1 mb-2.5">
					{icon && (
						<span
							className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0"
							style={{ background: accent ? `${accent}22` : undefined, color: accent }}
						>
							{icon}
						</span>
					)}
					<h2 className="text-text-faint text-[12px] font-semibold uppercase tracking-[0.08em]">
						{title}
					</h2>
				</div>
			)}
			<div className="bg-surface border border-border rounded-[20px] overflow-hidden shadow-e1">
				{children}
			</div>
		</div>
	);
}

const ICON = {
	user: (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<circle cx="12" cy="8" r="4" />
			<path d="M4 20c0-3.5 3.6-6 8-6s8 2.5 8 6" />
		</svg>
	),
	card: (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<rect x="3" y="6" width="18" height="13" rx="2" />
			<path d="M3 10h18" />
		</svg>
	),
	shield: (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M12 2 4 5v6c0 5 3.5 8 8 11 4.5-3 8-6 8-11V5l-8-3Z" />
		</svg>
	),
	coin: (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v10M9.5 9.5a2.5 2 0 0 1 5 0c0 2-5 1-5 3a2.5 2 0 0 0 5 0" />
		</svg>
	),
};

export default function Settings({ user }: { user: User }) {
	const navigate = useViewTransitionNavigate();
	const [username, setUsername] = useState("");
	const [currentUsername, setCurrentUsername] = useState<string | null>(null);
	const [walletAddress, setWalletAddress] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [copied, setCopied] = useState(false);
	const [passkeyStatus, setPasskeyStatus] =
		useState<PasskeyStatusResponse | null>(null);
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

	async function fetchFaucetStatusData(): Promise<{ funded: boolean } | null> {
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
	}

	useEffect(() => {
		let cancelled = false;
		async function loadSettings() {
			setInitialLoading(true);
			await refreshSettings();
			if (!cancelled) setInitialLoading(false);
		}
		void loadSettings();
		return () => {
			cancelled = true;
		};
	}, [user]);

	async function handleSaveUsername() {
		if (!username.trim() || username === currentUsername) return;
		setSaving(true);
		try {
			const normalizedUsername = username.trim().toLowerCase();
			const res = await fetchWithAuth(user, `${SERVER_URL}/user/username`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username: normalizedUsername }),
			});
			if (!res.ok) {
				const data = await res.json();
				throw new Error(data.error || "Error al guardar");
			}
			setCurrentUsername(normalizedUsername);
			sileo.success({ title: "Usuario guardado" });
		} catch (err) {
			sileo.error({
				title: "No se pudo guardar",
				description: err instanceof Error ? err.message : "Intenta de nuevo",
			});
		} finally {
			setSaving(false);
		}
	}

	async function handleAddPasskey() {
		setUpdatingPasskey(true);
		try {
			if (!user.uid) throw new Error("Tu sesión expiró. Vuelve a iniciar sesión.");
			const passkeyLabel = user.email || user.displayName || undefined;
			const nextPasskey = await createPasskey(user.uid, passkeyLabel);

			const intentRes = await fetchWithAuth(user, `${SERVER_URL}/account/passkey`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(nextPasskey),
			});
			if (!intentRes.ok) {
				const data = await intentRes
					.json()
					.catch(() => ({ error: "Error al preparar la nueva llave" }));
				throw new Error(data.error || "Error al preparar la nueva llave");
			}

			const intentData = (await intentRes.json()) as { addSignerCalldata?: string };
			if (!intentData.addSignerCalldata) {
				throw new Error("No recibimos los datos para agregar la llave.");
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
				hexToBytes(userOpHash),
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
					.catch(() => ({ error: "Error al activar la nueva llave" }));
				throw new Error(data.error || "Error al activar la nueva llave");
			}

			await refreshSettings();
			sileo.success({
				title: "Llave agregada",
				description: "Ya puedes confirmar pagos desde este dispositivo.",
			});
		} catch (err) {
			sileo.error({
				title: "No se pudo agregar la llave",
				description: err instanceof Error ? err.message : "Intenta de nuevo",
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
					sileo.warning({ title: "Ya recibiste tus dólares de prueba" });
					return;
				}
				throw new Error(data.error || "Error al obtener dólares de prueba");
			}
			setFaucetClaimed(true);
			sileo.success({
				title: "¡Listo!",
				description: "Recibiste 5 dólares digitales de prueba.",
			});
		} catch (err) {
			sileo.error({
				title: "No se pudo completar",
				description: err instanceof Error ? err.message : "Intenta de nuevo",
			});
		} finally {
			setClaimingFaucet(false);
		}
	}

	const recoveryDateLabel = passkeyStatus?.recoveryExecutableAfter
		? new Date(passkeyStatus.recoveryExecutableAfter).toLocaleDateString("es", {
				day: "numeric",
				month: "long",
		  })
		: null;
	const keyCount = passkeyStatus?.signerCount || 1;
	const recoveryOn = !isZeroAddress(passkeyStatus?.guardian);
	const usernameChanged = !!username.trim() && username !== currentUsername;

	return (
		<div className="flex flex-col min-h-dvh px-5 pt-6 pb-12 w-full max-w-[460px] mx-auto">
			<header className="flex items-center gap-3 mb-7">
				<button
					onClick={() => navigate("/")}
					aria-label="Volver"
					className="w-10 h-10 -ml-1 rounded-full flex items-center justify-center text-text-muted hover:text-text hover:bg-surface transition-colors"
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M19 12H5" />
						<path d="M12 19l-7-7 7-7" />
					</svg>
				</button>
				<h1 className="text-[26px]">Ajustes</h1>
			</header>

			{initialLoading ? (
				<div className="flex-1 flex flex-col items-center justify-center gap-4 text-center">
					<div className="w-8 h-8 border-2 border-surface-2 border-t-sky rounded-full animate-spin" />
					<p className="text-sm text-text-muted">Cargando tus ajustes…</p>
				</div>
			) : (
				<div className="animate-fade-up">
					{/* Profile */}
					<div className="flex items-center gap-4 mb-6 px-1">
						{user.photoURL ? (
							<img
								src={user.photoURL}
								alt=""
								referrerPolicy="no-referrer"
								className="w-14 h-14 rounded-full object-cover"
							/>
						) : (
							<div className="w-14 h-14 rounded-full bg-sky/15 flex items-center justify-center text-xl font-display text-sky">
								{(user.displayName || user.email || "?")[0].toUpperCase()}
							</div>
						)}
						<div className="min-w-0">
							{user.displayName && (
								<p className="font-display text-[18px] truncate">{user.displayName}</p>
							)}
							{user.email && (
								<p className="text-[13px] text-text-muted truncate">{user.email}</p>
							)}
						</div>
					</div>

					{/* Username */}
					<Section title="Tu usuario" icon={ICON.user} accent="#f4a9cf">
						<div className="p-5">
							<p className="text-[13px] text-text-muted mb-3">
								Recibe pagos con un nombre fácil de compartir.
							</p>
							<div className="flex items-center gap-2 bg-bg border border-border rounded-[14px] h-12 px-3.5 mb-3 focus-within:border-border-strong transition-colors">
								<span className="text-text-faint text-[14px]">
									{new URL(APP_URL).host}/
								</span>
								<input
									type="text"
									placeholder="tunombre"
									value={username}
									onChange={(e) =>
										setUsername(e.target.value.replace(/[^a-z0-9_-]/gi, "").toLowerCase())
									}
									maxLength={30}
									className="flex-1 bg-transparent text-text text-[14px] placeholder:text-text-faint min-w-0"
								/>
							</div>
							<button
								onClick={handleSaveUsername}
								disabled={saving || !usernameChanged}
								className="btn btn-primary btn-sm"
							>
								{saving ? "Guardando…" : "Guardar"}
							</button>
						</div>
					</Section>

					{/* Contacts & invitations */}
					<Section title="Amigos" icon={ICON.user} accent="#9ce3f4">
						<button
							onClick={() => navigate("/contacts")}
							className="w-full flex items-center justify-between p-5 hover:bg-surface-2 transition-colors text-left"
						>
							<div>
								<p className="text-[15px] mb-0.5">Contactos e invitaciones</p>
								<p className="text-[13px] text-text-muted">
									Agrega amigos, págales en un toque e invita gente a Parmelia.
								</p>
							</div>
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-faint shrink-0 ml-3">
								<path d="m9 18 6-6-6-6" />
							</svg>
						</button>
					</Section>

					{/* Account / address */}
					{walletAddress && (
						<Section title="Tu cuenta" icon={ICON.card} accent="#efe08c">
							<div className="p-5">
								<div className="flex items-center justify-between mb-1.5">
									<span className="text-[13px] text-text-muted">Dirección</span>
									<span className="text-[11px] px-2.5 py-1 rounded-full bg-white/[0.06] text-text-muted">
										{activeNetwork.name}
									</span>
								</div>
								<p className="font-mono text-[14px] text-text mb-4 tabular">
									{shortAddress(walletAddress)}
								</p>
								<div className="flex gap-2.5">
									<button
										onClick={() => {
											navigator.clipboard.writeText(walletAddress);
											sileo.success({ title: "Dirección copiada" });
											setCopied(true);
											setTimeout(() => setCopied(false), 2000);
										}}
										className="btn btn-ghost btn-sm flex-1"
									>
										{copied ? "Copiado ✓" : "Copiar"}
									</button>
									<a
										href={`${activeNetwork.explorerBaseUrl}/address/${walletAddress}`}
										target="_blank"
										rel="noopener noreferrer"
										className="btn btn-ghost btn-sm flex-1"
									>
										Ver en explorador
									</a>
								</div>
							</div>
						</Section>
					)}

					{/* Security */}
					{walletAddress && (
						<Section title="Seguridad" icon={ICON.shield} accent="#9ce3f4">
							<div className="p-5">
								<div className="flex items-start gap-3 mb-4">
									<div className="w-9 h-9 rounded-full bg-sky/15 flex items-center justify-center shrink-0 mt-0.5">
										<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#9ce3f4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											<path d="M12 1a4 4 0 0 0-4 4v2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2h-2V5a4 4 0 0 0-4-4Z" />
											<circle cx="12" cy="14" r="1.5" fill="#9ce3f4" stroke="none" />
										</svg>
									</div>
									<div>
										<p className="font-display text-[16px] leading-tight">
											Tu huella es tu llave
										</p>
										<p className="text-[13px] text-text-muted leading-relaxed mt-1">
											Confirmas cada pago con tu huella o tu rostro. Nadie más
											puede mover tu dinero.
										</p>
									</div>
								</div>

								<div className="flex gap-2.5 mb-4">
									<div className="flex-1 bg-surface-2 rounded-[14px] px-3.5 py-3">
										<p className="font-display text-[20px] text-sky tabular">{keyCount}</p>
										<p className="text-[12px] text-text-muted mt-0.5">
											{keyCount === 1 ? "Llave activa" : "Llaves activas"}
										</p>
									</div>
									<div className="flex-1 bg-surface-2 rounded-[14px] px-3.5 py-3">
										<p className="font-display text-[20px] text-cream">
											{recoveryOn ? "Sí" : "—"}
										</p>
										<p className="text-[12px] text-text-muted mt-0.5">Recuperación</p>
									</div>
								</div>

								{passkeyStatus?.recoveryPending && (
									<div className="bg-glow-pink/10 border border-glow-pink/20 rounded-[14px] p-3.5 mb-4">
										<p className="text-[13px] text-glow-pink leading-relaxed">
											Hay una recuperación en proceso
											{recoveryDateLabel ? ` — disponible el ${recoveryDateLabel}` : ""}.
										</p>
									</div>
								)}

								<button
									onClick={handleAddPasskey}
									disabled={updatingPasskey}
									className="btn btn-ghost btn-block"
								>
									{updatingPasskey ? "Agregando…" : "Agregar otra llave (respaldo)"}
								</button>
								<p className="text-[12px] text-text-faint leading-relaxed mt-2.5 px-0.5">
									Agrega la huella de otro dispositivo para no perder tu cuenta si
									pierdes este.
								</p>
							</div>
						</Section>
					)}

					{/* Test funds */}
					{walletAddress && (
						<Section title="Dólares de prueba" icon={ICON.coin} accent="#efe08c">
							<div className="p-5">
								{faucetClaimed === null ? (
									<p className="text-[13px] text-text-muted">Cargando…</p>
								) : faucetClaimed ? (
									<>
										<p className="text-[13px] text-text-muted leading-relaxed mb-3">
											Ya recibiste tus dólares de prueba en esta cuenta.
											{activeNetwork.faucetUrl
												? " ¿Necesitas más? Usa el faucet externo."
												: ""}
										</p>
										{activeNetwork.faucetUrl && (
											<a
												href={activeNetwork.faucetUrl}
												target="_blank"
												rel="noopener noreferrer"
												className="btn btn-ghost btn-sm"
											>
												Abrir {activeNetwork.faucetLabel}
											</a>
										)}
									</>
								) : (
									<>
										<p className="text-[13px] text-text-muted leading-relaxed mb-3">
											Recibe 5 dólares digitales de prueba para empezar a cobrar y
											pagar.
										</p>
										<button
											onClick={handleClaimFaucet}
											disabled={claimingFaucet}
											className="btn btn-primary btn-sm"
										>
											{claimingFaucet ? "Enviando…" : "Obtener dólares de prueba"}
										</button>
									</>
								)}
							</div>
						</Section>
					)}

					{/* Logout */}
					<button
						onClick={() => logOut()}
						className="btn btn-block text-danger border border-danger/45 hover:bg-danger/10"
					>
						Cerrar sesión
					</button>
				</div>
			)}
		</div>
	);
}

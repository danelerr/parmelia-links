import { useEffect, useState } from "react";
import { useSearchParams, useParams, useNavigate } from "react-router-dom";
import { sileo } from "sileo";
import { signInWithGoogle, type User } from "../firebase";
import Logo from "../components/Logo";
import { fetchWithAuth } from "../authFetch";
import { signWithPasskey } from "../webauthn";
import { activeNetwork } from "../network";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";
const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.me";
const APP_HOST = new URL(APP_URL).hostname;

interface LinkData {
	id: string;
	amount: string;
	currency: string;
	reference: string;
	wallet: string;
	status: "pending" | "paid";
	username?: string;
}

interface UserProfile {
	username: string;
	walletAddress: string;
}

export default function PayPage({ user }: { user: User | null }) {
	const [searchParams] = useSearchParams();
	const { username } = useParams();
	const navigate = useNavigate();
	const [linkData, setLinkData] = useState<LinkData | null>(null);
	const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
	const [loading, setLoading] = useState(true);
	const [paying, setPaying] = useState(false);
	const [error, setError] = useState("");
	const [payAmount, setPayAmount] = useState("");
	const [payCurrency, setPayCurrency] = useState("USDC");
	const [showPayForm, setShowPayForm] = useState(false);
	const [manualMode, setManualMode] = useState(false);
	const [manualWallet, setManualWallet] = useState("");
	const [slowConnection, setSlowConnection] = useState(false);
	const [destType, setDestType] = useState<"address" | "username">("address");
	const [resolvingUsername, setResolvingUsername] = useState(false);

	const linkId = searchParams.get("id");
	const amountParam = searchParams.get("amount");
	const currencyParam = searchParams.get("currency") || "USDC";
	const refParam = searchParams.get("ref");

	useEffect(() => {
		const slowTimer = setTimeout(() => setSlowConnection(true), 5000);

		async function fetchLink(id: string) {
			try {
				const res = await fetch(`${SERVER_URL}/links/${id}`);
				if (!res.ok) throw new Error("Link no encontrado");
				const data = await res.json();
				setLinkData(data);
			} catch {
				setError("Link de pago no encontrado");
			} finally {
				setLoading(false);
			}
		}

		async function fetchByUsername(uname: string) {
			try {
				const res = await fetch(`${SERVER_URL}/user/${uname}`);
				if (!res.ok) throw new Error("Usuario no encontrado");
				const data = await res.json();
				setUserProfile(data);
				setLinkData({
					id: "username",
					amount: amountParam || "",
					currency: currencyParam,
					reference: refParam || "",
					wallet: data.walletAddress,
					status: "pending",
					username: uname,
				});
			} catch {
				setError("Usuario no encontrado");
			} finally {
				setLoading(false);
			}
		}

		if (linkId) {
			fetchLink(linkId);
		} else if (username) {
			fetchByUsername(username);
		} else if (amountParam) {
			setLinkData({
				id: "direct",
				amount: amountParam,
				currency: currencyParam,
				reference: refParam || "",
				wallet: searchParams.get("wallet") || "",
				status: "pending",
			});
			setLoading(false);
		} else {
			setManualMode(true);
			setLoading(false);
		}

		return () => clearTimeout(slowTimer);
	}, [linkId, username, amountParam, currencyParam, refParam, searchParams]);

	/** Two-step pay: prepare → biometric sign → submit */
	async function executePay(params: {
		linkId: string;
		wallet: string;
		amount: string;
		currency: string;
	}) {
		if (!user) return;
		setPaying(true);
		setError("");
		const paySlowTimer = setTimeout(() => setSlowConnection(true), 5000);
		try {
			// Step 1: Ask server to build the unsigned UserOp
			const prepRes = await fetchWithAuth(user, `${SERVER_URL}/pay/prepare`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(params),
			});
			if (!prepRes.ok) {
				const data = await prepRes.json().catch(() => ({ error: "Pago fallo" }));
				throw new Error(data.error || "Pago fallo");
			}
			const { userOpHash, credentialId } = await prepRes.json();

			// Step 2: Sign with passkey (biometric prompt)
			const challengeBytes = hexToBytes(userOpHash);
			const assertion = await signWithPasskey(challengeBytes, credentialId);

			// Step 3: Submit the signed UserOp
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
				const data = await submitRes.json().catch(() => ({ error: "Pago fallo" }));
				throw new Error(data.error || "Pago fallo");
			}
			const { txHash } = await submitRes.json();
			navigate(`/pay/status?tx=${txHash}&amount=${params.amount}&currency=${params.currency}&to=${params.linkId === "username" ? (linkData?.username || params.wallet) : params.wallet}`);
		} catch (err) {
			const raw = err instanceof Error ? err.message : "Error al procesar pago";
			const msg = parsePaymentError(raw);
			sileo.error({ title: "Pago fallido", description: msg });
			setError(msg);
		} finally {
			clearTimeout(paySlowTimer);
			setSlowConnection(false);
			setPaying(false);
		}
	}

	function hexToBytes(hex: string): Uint8Array {
		const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
		const bytes = new Uint8Array(clean.length / 2);
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
		}
		return bytes;
	}

	function parsePaymentError(msg: string): string {
		if (msg.includes("AA24")) return "Error de firma. Prueba con tu passkey sincronizada o usa autenticacion desde otro dispositivo.";
		if (msg.includes("AA21")) return "Fondos insuficientes para gas.";
		if (msg.includes("AA25")) return "Datos de firma inválidos.";
		if (msg.includes("Missing qx/qy")) {
			return "No pudimos identificar la passkey usada en este dispositivo. Intenta de nuevo desde el mismo navegador donde la registraste en Parmelia.";
		}
		if (msg.includes("Saldo USDC insuficiente") || msg.includes("Saldo ETH insuficiente")) return msg;
		if (msg.includes("Passkey not found") || msg.includes("Passkey no encontrada")) {
			return "No se encontro una passkey compatible para esta wallet.";
		}
		if (msg.includes("No passkeys available") || msg.includes(`No passkeys available for ${APP_HOST}`)) {
			return `No hay passkeys disponibles para ${APP_HOST} en este dispositivo. Si tu passkey fue creada en otro dominio de Parmelia, como parmelia.vercel.app, el navegador no la puede usar aqui.`;
		}
		if (msg.includes("NotAllowedError") || msg.includes("timed out or was not allowed") || msg.includes("Firma cancelada")) {
			return `La firma fue cancelada o este dispositivo no encontro una passkey utilizable para ${APP_HOST}. Si la passkey se creo bajo otro dominio de Parmelia, aqui no aparecera.`;
		}
		if (msg.includes("insufficient") || msg.includes("Insufficient")) return "Saldo insuficiente.";
		if (msg.includes("FailedOp")) {
			const match = msg.match(/FailedOp\([^,]+,\s*"?([^"\)]+)/);
			if (match) return `Error: ${match[1]}`;
		}
		if (msg.length > 150) return "Error al procesar el pago. Intenta de nuevo.";
		return msg;
	}

	async function handlePay() {
		if (!linkData || !user) return;
		const isStoredLink = !["direct", "username", "manual"].includes(linkData.id);
		const hasFixedAmount = Number(linkData.amount) > 0;
		const amount = hasFixedAmount ? linkData.amount : payAmount;
		const currency = isStoredLink || hasFixedAmount ? linkData.currency : payCurrency;
		if (!amount || Number(amount) <= 0) {
			sileo.error({ title: "Monto inválido", description: "El monto debe ser mayor a 0" });
			return;
		}
		await executePay({
			linkId: linkData.id,
			wallet: linkData.wallet,
			amount,
			currency,
		});
	}

	async function handleManualPay() {
		if (!user || !payAmount) return;

		let targetWallet = manualWallet;

		if (destType === "username") {
			if (!manualWallet.trim()) {
				sileo.error({ title: "Usuario requerido" });
				return;
			}
			setResolvingUsername(true);
			try {
				const res = await fetch(`${SERVER_URL}/user/${manualWallet.trim().toLowerCase()}`);
				if (!res.ok) throw new Error();
				const data = await res.json();
				if (!data.walletAddress) throw new Error();
				targetWallet = data.walletAddress;
			} catch {
				sileo.error({ title: "Usuario no encontrado", description: "Verifica el nombre de usuario" });
				setResolvingUsername(false);
				return;
			} finally {
				setResolvingUsername(false);
			}
		} else {
			if (!/^0x[a-fA-F0-9]{40}$/.test(manualWallet)) {
				sileo.error({ title: "Wallet inválida", description: "Debe ser una dirección 0x válida" });
				return;
			}
		}

		await executePay({
			linkId: "manual",
			wallet: targetWallet,
			amount: payAmount,
			currency: payCurrency,
		});
	}

	async function handleLogin() {
		try {
			const credential = await signInWithGoogle();
			await credential.user.getIdToken(true);
		} catch (err) {
			sileo.error({ title: "Error", description: "No se pudo iniciar sesion" });
		}
	}

	if (loading) {
		return (
			<div className="flex flex-col items-center justify-center min-h-dvh px-6 gap-4">
				<Logo className="w-16 animate-pulse" />
				{slowConnection && (
					<p className="text-muted text-sm animate-fade-in">Conexión lenta, por favor espera...</p>
				)}
			</div>
		);
	}

	if (error && !linkData) {
		return (
			<div className="flex flex-col items-center justify-center min-h-dvh gap-6 px-8">
				<Logo className="w-16" />
				<p className="text-parmelia-pink">{error}</p>
				<button
					onClick={() => navigate(-1)}
					className="bg-parmelia-gold text-black px-6 py-2.5 rounded-full text-sm font-medium"
				>
					Volver
				</button>
			</div>
		);
	}

	if (!linkData && manualMode) {
		return (
			<div className="flex flex-col min-h-dvh px-5 sm:px-8 pt-6 sm:pt-10 pb-12 w-full max-w-lg mx-auto">
				{/* Header */}
				<div className="flex items-center justify-between mb-8">
					<button
						onClick={() => navigate(-1)}
						className="flex items-center gap-1.5 text-sm text-muted hover:text-white transition-colors"
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
						</svg>
						Volver
					</button>
					<Logo className="w-7" />
				</div>

				{/* Manual pay form */}
				<div className="bg-surface rounded-2xl p-8 sm:p-10 flex-1 flex flex-col">
					<h2 className="text-2xl sm:text-3xl mb-8 text-center">Pagar</h2>
					<p className="text-xs text-muted text-center mb-8">
						Red activa: {activeNetwork.name}
					</p>

					<div className="space-y-4 w-full max-w-xs mx-auto">
						<div>
							<label className="text-sm text-muted mb-2 block">Tipo de destino</label>
							<select
								value={destType}
								onChange={(e) => { setDestType(e.target.value as "address" | "username"); setManualWallet(""); }}
								className="w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm"
							>
								<option value="address">Dirección de wallet</option>
								<option value="username">Nombre de usuario</option>
							</select>
						</div>

						<div>
							<label className="text-sm text-muted mb-2 block">
								{destType === "address" ? "Wallet destino" : "Usuario destino"}
							</label>
							<input
								type="text"
								placeholder={destType === "address" ? "0x..." : "ej: daniel"}
								value={manualWallet}
								onChange={(e) => setManualWallet(destType === "username" ? e.target.value.replace(/[^a-z0-9_-]/gi, "").toLowerCase() : e.target.value.trim())}
								className={`w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm ${destType === "address" ? "font-mono" : ""}`}
							/>
						</div>

						<div>
							<label className="text-sm text-muted mb-2 block">Moneda</label>
							<select
								value={payCurrency}
								onChange={(e) => setPayCurrency(e.target.value)}
								className="w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm"
							>
								<option value="USDC">USDC</option>
								<option value="ETH">ETH</option>
							</select>
						</div>

						<div>
							<label className="text-sm text-muted mb-2 block">Monto</label>
							<input
								type="number"
								placeholder="0.00"
								value={payAmount}
								onChange={(e) => setPayAmount(e.target.value)}
								step="any"
								min="0"
								inputMode="decimal"
								className="w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm"
							/>
						</div>
					</div>

					{error && (
						<p className="text-parmelia-pink text-sm text-center mt-4">{error}</p>
					)}
				</div>

				{/* Action */}
				<div className="flex flex-col items-center gap-3 mt-6">
					{!user ? (
						<button
							onClick={handleLogin}
							className="bg-parmelia-gold text-black px-10 py-3 rounded-full text-sm font-medium"
						>
							Inicia sesion para pagar
						</button>
					) : (
						<button
							onClick={handleManualPay}
							disabled={paying || resolvingUsername || !manualWallet || !payAmount}
							className="bg-parmelia-blue text-black px-10 py-3 rounded-full text-sm font-medium disabled:opacity-50 transition-opacity"
						>
							{paying ? (slowConnection ? "Conexión lenta..." : resolvingUsername ? "Buscando usuario..." : "Procesando...") : "Pagar"}
						</button>
					)}
				</div>
			</div>
		);
	}

	if (!linkData) return null;

	const isStoredLink = !["direct", "username", "manual"].includes(linkData.id);
	const hasFixedAmount = Number(linkData.amount) > 0;

	// Username profile page — show profile card with transfer button
	if (username && userProfile && !showPayForm) {
		return (
			<div className="flex flex-col min-h-dvh px-5 sm:px-8 pt-6 sm:pt-10 pb-12 w-full max-w-lg mx-auto">
				{/* Header */}
				<div className="flex items-center justify-between mb-8">
					<button
						onClick={() => navigate(-1)}
						className="flex items-center gap-1.5 text-sm text-muted hover:text-white transition-colors"
					>
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
						</svg>
						Volver
					</button>
				</div>

				{/* Profile card */}
				<div className="bg-surface rounded-2xl p-8 sm:p-10 flex-1 flex flex-col items-center justify-center">
					<Logo className="w-16 mb-8" />

					<h2 className="text-2xl sm:text-3xl mb-1">
						@{userProfile.username}
					</h2>
					<p className="text-xs text-muted text-center">
						Recibir en {activeNetwork.name}
					</p>

					<p className="text-xs text-muted font-mono break-all text-center px-4 leading-relaxed mt-4">
						{userProfile.walletAddress}
					</p>
				</div>

				{/* Transfer button */}
				<div className="flex justify-center mt-6">
					<button
						onClick={() => {
							if (!user) {
								handleLogin();
							} else {
								setShowPayForm(true);
							}
						}}
						className="bg-parmelia-blue text-black px-12 py-3 rounded-full text-sm font-medium"
					>
						{user ? "Transferir" : "Inicia sesion para transferir"}
					</button>
				</div>
			</div>
		);
	}

	// Payment form (for username transfers or link payments)
	return (
		<div className="flex flex-col min-h-dvh px-5 sm:px-8 pt-6 sm:pt-10 pb-12 w-full max-w-lg mx-auto">
			{/* Header */}
			<div className="flex items-center justify-between mb-8">
				<button
					onClick={() => {
						if (showPayForm) {
							setShowPayForm(false);
						} else {
							navigate(-1);
						}
					}}
					className="flex items-center gap-1.5 text-sm text-muted hover:text-white transition-colors"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
					</svg>
					Volver
				</button>
				<div className="flex items-center gap-2">
					<Logo className="w-7" />
				</div>
			</div>

			{/* Payment card */}
			<div className="bg-surface rounded-2xl p-8 sm:p-10 flex-1 flex flex-col items-center justify-center">
				{linkData.status === "paid" ? (
					<>
						<p className="text-3xl mb-4">Pagado</p>
						<p className="text-lg">{linkData.amount} {linkData.currency}</p>
						{linkData.reference && (
							<p className="text-muted text-sm text-center px-6 leading-relaxed mt-3">
								{linkData.reference}
							</p>
						)}
					</>
				) : hasFixedAmount ? (
					<>
						<h2 className="text-4xl sm:text-5xl mb-6">Pagar</h2>
						<p className="text-xs text-muted mb-4 text-center">
							Red activa: {activeNetwork.name}
						</p>
						<p className="text-xl mb-4">{linkData.amount} {linkData.currency}</p>
						{linkData.reference && (
							<p className="text-muted text-sm text-center px-6 leading-relaxed mt-1">
								{linkData.reference}
							</p>
						)}
					</>
				) : isStoredLink ? (
					<>
						<h2 className="text-2xl sm:text-3xl mb-6">Pagar</h2>
						<p className="text-xs text-muted mb-4 text-center">
							Red activa: {activeNetwork.name}
						</p>
						<p className="text-sm text-muted mb-4">Moneda: {linkData.currency}</p>
						<div className="w-full max-w-xs">
							<label className="text-sm text-muted mb-2 block">Monto</label>
							<input
								type="number"
								placeholder="0.00"
								value={payAmount}
								onChange={(e) => setPayAmount(e.target.value)}
								step="any"
								min="0"
								inputMode="decimal"
								className="w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm"
							/>
						</div>
						{linkData.reference && (
							<p className="text-muted text-sm text-center px-6 leading-relaxed mt-4">
								{linkData.reference}
							</p>
						)}
					</>
				) : (
					<>
						<h2 className="text-2xl sm:text-3xl mb-6">
							{linkData.username ? `Transferir a @${linkData.username}` : "Pagar"}
						</h2>
						<p className="text-xs text-muted mb-4 text-center">
							Red activa: {activeNetwork.name}
						</p>
						<div className="w-full max-w-xs mb-4">
							<label className="text-sm text-muted mb-2 block">Moneda</label>
							<select
								value={payCurrency}
								onChange={(e) => setPayCurrency(e.target.value)}
								className="w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm"
							>
								<option value="USDC">USDC</option>
								<option value="ETH">ETH</option>
							</select>
						</div>
						<div className="w-full max-w-xs">
							<label className="text-sm text-muted mb-2 block">Monto</label>
							<input
								type="number"
								placeholder="0.00"
								value={payAmount}
								onChange={(e) => setPayAmount(e.target.value)}
								step="any"
								min="0"
								inputMode="decimal"
								className="w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm"
							/>
						</div>
					</>
				)}
			</div>

			{error && (
				<p className="text-parmelia-pink text-sm text-center mt-4">{error}</p>
			)}

			{/* Action */}
			{linkData.status !== "paid" && (
				<div className="flex flex-col items-center gap-3 mt-6">
					{!user ? (
						<button
							onClick={handleLogin}
							className="bg-parmelia-gold text-black px-10 py-3 rounded-full text-sm font-medium"
						>
							Inicia sesion para pagar
						</button>
					) : (
						<button
							onClick={handlePay}
							disabled={paying || (!hasFixedAmount && !payAmount)}
							className="bg-parmelia-blue text-black px-10 py-3 rounded-full text-sm font-medium disabled:opacity-50 transition-opacity"
						>
							{paying ? (slowConnection ? "Conexión lenta..." : "Procesando...") : "Confirmar pago"}
						</button>
					)}
				</div>
			)}
		</div>
	);
}

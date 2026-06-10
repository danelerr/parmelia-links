import { useEffect, useState } from "react";
import { useSearchParams, useParams } from "react-router-dom";
import { sileo } from "sileo";
import { signInWithGoogle, type User } from "../lib/firebase";
import Logo from "../components/Logo";
import { fetchWithAuth } from "../lib/authFetch";
import { signWithPasskey } from "../lib/webauthn";
import { activeNetwork } from "../lib/activeNetwork";
import { hexToBytes } from "../lib/hex";
import { useViewTransitionNavigate } from "../hooks/useNav";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";
const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.me";
const APP_HOST = new URL(APP_URL).hostname;

type PayStage = "idle" | "preparing" | "signing" | "securing";

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

function BackButton({ onClick }: { onClick: () => void }) {
	return (
		<button
			onClick={onClick}
			aria-label="Volver"
			className="w-10 h-10 -ml-1 rounded-full flex items-center justify-center text-text-muted hover:text-text hover:bg-surface transition-colors"
		>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
				<path d="M19 12H5" />
				<path d="M12 19l-7-7 7-7" />
			</svg>
		</button>
	);
}

/** Anti-phishing trust seal — always visible when paying. */
function TrustBadge() {
	return (
		<div className="flex items-center justify-center gap-2 mb-7">
			<Logo className="w-6" />
			<span className="text-[13px] text-text-muted">
				Pago seguro con <span className="text-text font-medium">Parmelia</span>
			</span>
		</div>
	);
}

function Recipient({ label }: { label: string }) {
	return (
		<div className="flex flex-col items-center gap-2 mb-6">
			<div className="w-12 h-12 rounded-full bg-pink/15 flex items-center justify-center font-display text-[18px] text-glow-pink uppercase">
				{label.replace(/^@/, "")[0] || "?"}
			</div>
			<p className="text-[14px] text-text-muted">
				Pagas a <span className="text-text font-medium">{label}</span>
			</p>
		</div>
	);
}

function PayingOverlay({ stage }: { stage: PayStage }) {
	const copy: Record<Exclude<PayStage, "idle">, string> = {
		preparing: "Preparando tu pago…",
		signing: "Confirma con tu huella",
		securing: "Asegurando en la red…",
	};
	if (stage === "idle") return null;
	return (
		<div className="fixed inset-0 z-50 bg-bg/92 backdrop-blur-sm flex flex-col items-center justify-center gap-6 animate-fade-in">
			<Logo className="w-16 animate-float-glow" />
			<div className="flex flex-col items-center gap-3">
				{stage !== "signing" && (
					<div className="w-6 h-6 border-2 border-surface-2 border-t-sky rounded-full animate-spin" />
				)}
				<p className="text-[16px] text-text font-display">{copy[stage]}</p>
			</div>
		</div>
	);
}

export default function PayPage({ user }: { user: User | null }) {
	const [searchParams] = useSearchParams();
	const { username } = useParams();
	const navigate = useViewTransitionNavigate();
	const [linkData, setLinkData] = useState<LinkData | null>(null);
	const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
	const [loading, setLoading] = useState(true);
	const [paying, setPaying] = useState(false);
	const [payStage, setPayStage] = useState<PayStage>("idle");
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
	const walletParam = searchParams.get("wallet");
	const symbol = activeNetwork.nativeTokenSymbol;

	useEffect(() => {
		const slowTimer = setTimeout(() => setSlowConnection(true), 5000);

		async function fetchLink(id: string) {
			try {
				const res = await fetch(`${SERVER_URL}/links/${id}`);
				if (!res.ok) throw new Error("Link no encontrado");
				setLinkData(await res.json());
			} catch {
				setError("Este link de cobro no existe o expiró.");
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
				setError("No encontramos a ese usuario.");
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
				wallet: walletParam || "",
				status: "pending",
			});
			setLoading(false);
		} else {
			setManualMode(true);
			setLoading(false);
		}

		return () => clearTimeout(slowTimer);
		// Depend on the parsed primitives only — searchParams is a fresh object
		// each render and would re-run this fetch effect unnecessarily.
	}, [linkId, username, amountParam, currencyParam, refParam, walletParam]);

	/** Two-step pay: prepare → biometric sign → submit, with human micro-states. */
	async function executePay(params: { linkId: string; wallet: string; amount: string; currency: string }) {
		if (!user) return;
		setPaying(true);
		setError("");
		setPayStage("preparing");
		const paySlowTimer = setTimeout(() => setSlowConnection(true), 6000);
		try {
			const prepRes = await fetchWithAuth(user, `${SERVER_URL}/pay/prepare`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(params),
			});
			if (!prepRes.ok) {
				const data = await prepRes.json().catch(() => ({ error: "El pago falló" }));
				throw new Error(data.error || "El pago falló");
			}
			const { userOpHash, credentialId } = await prepRes.json();

			setPayStage("signing");
			const challengeBytes = hexToBytes(userOpHash);
			const assertion = await signWithPasskey(challengeBytes, credentialId);

			setPayStage("securing");
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
				const data = await submitRes.json().catch(() => ({ error: "El pago falló" }));
				throw new Error(data.error || "El pago falló");
			}
			const { txHash } = await submitRes.json();
			const to = params.linkId === "username" ? linkData?.username || params.wallet : params.wallet;
			navigate(`/pay/status?tx=${txHash}&amount=${params.amount}&currency=${params.currency}&to=${to}`);
		} catch (err) {
			const raw = err instanceof Error ? err.message : "Error al procesar el pago";
			const msg = parsePaymentError(raw);
			sileo.error({ title: "No se pudo pagar", description: msg });
			setError(msg);
		} finally {
			clearTimeout(paySlowTimer);
			setSlowConnection(false);
			setPaying(false);
			setPayStage("idle");
		}
	}

	function parsePaymentError(msg: string): string {
		if (msg.includes("AA24")) return "No pudimos validar tu huella. Intenta de nuevo desde el dispositivo donde la creaste.";
		if (msg.includes("AA21")) return "Saldo insuficiente para completar el pago.";
		if (msg.includes("AA25")) return "Datos de firma inválidos. Intenta de nuevo.";
		if (msg.includes("Missing qx/qy")) {
			return "No reconocimos tu huella en este dispositivo. Intenta desde el navegador donde la registraste.";
		}
		if (
			msg.includes("Saldo USDC insuficiente") ||
			msg.includes(`Saldo ${activeNetwork.nativeTokenSymbol} insuficiente`) ||
			msg.includes("Saldo ETH insuficiente")
		)
			return msg;
		if (msg.includes("Passkey not found") || msg.includes("Passkey no encontrada")) {
			return "No encontramos una huella compatible con esta cuenta.";
		}
		if (msg.includes("No passkeys available")) {
			return `No hay huellas disponibles para ${APP_HOST} en este dispositivo.`;
		}
		if (msg.includes("NotAllowedError") || msg.includes("timed out or was not allowed") || msg.includes("Firma cancelada")) {
			return "Cancelaste la confirmación o este dispositivo no encontró tu huella.";
		}
		if (msg.includes("insufficient") || msg.includes("Insufficient")) return "Saldo insuficiente.";
		if (msg.includes("FailedOp")) {
			const match = msg.match(/FailedOp\([^,]+,\s*"?([^"\)]+)/);
			if (match) return `Error: ${match[1]}`;
		}
		if (msg.length > 150) return "No se pudo procesar el pago. Intenta de nuevo.";
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
		await executePay({ linkId: linkData.id, wallet: linkData.wallet, amount, currency });
	}

	async function handleManualPay() {
		if (!user || !payAmount) return;
		let targetWallet = manualWallet;

		if (destType === "username") {
			if (!manualWallet.trim()) {
				sileo.error({ title: "Escribe un usuario" });
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
				sileo.error({ title: "Usuario no encontrado", description: "Revisa el nombre" });
				setResolvingUsername(false);
				return;
			} finally {
				setResolvingUsername(false);
			}
		} else if (!/^0x[a-fA-F0-9]{40}$/.test(manualWallet)) {
			sileo.error({ title: "Dirección inválida", description: "Debe ser una dirección 0x válida" });
			return;
		}

		await executePay({ linkId: "manual", wallet: targetWallet, amount: payAmount, currency: payCurrency });
	}

	async function handleLogin() {
		try {
			const credential = await signInWithGoogle();
			await credential.user.getIdToken(true);
		} catch {
			sileo.error({ title: "No pudimos iniciar sesión" });
		}
	}

	const screen = "flex flex-col min-h-dvh px-5 pt-6 pb-10 w-full max-w-[460px] mx-auto";
	const bigInput =
		"w-full max-w-[260px] bg-transparent text-center font-display text-[56px] leading-none text-text placeholder:text-text-faint tabular";

	if (loading) {
		return (
			<div className="flex flex-col items-center justify-center min-h-dvh px-6 gap-4">
				<Logo className="w-16 animate-float-glow" />
				{slowConnection && <p className="text-text-muted text-[14px] animate-fade-in">Conexión lenta, un momento…</p>}
			</div>
		);
	}

	if (error && !linkData) {
		return (
			<div className="flex flex-col items-center justify-center min-h-dvh gap-5 px-8 text-center">
				<Logo className="w-14 opacity-50" />
				<p className="text-text text-[16px] max-w-[280px]">{error}</p>
				<button onClick={() => navigate("/")} className="btn btn-primary btn-sm">
					Ir al inicio
				</button>
			</div>
		);
	}

	// Manual pay (open the app with no link)
	if (!linkData && manualMode) {
		return (
			<div className={screen}>
				<PayingOverlay stage={payStage} />
				<header className="flex items-center gap-3 mb-6">
					<BackButton onClick={() => navigate(-1)} />
					<h1 className="text-[22px]">Pagar o enviar</h1>
				</header>

				<TrustBadge />

				<div className="flex flex-col items-center mb-6">
					<input
						type="number"
						placeholder="0"
						value={payAmount}
						onChange={(e) => setPayAmount(e.target.value)}
						step="any"
						min="0"
						inputMode="decimal"
						autoFocus
						className={bigInput}
					/>
					<div className="seg-track mt-4">
						{(["USDC", "ETH"] as const).map((c) => (
							<button key={c} onClick={() => setPayCurrency(c)} data-active={payCurrency === c} className="seg-item">
								{c === "USDC" ? "USDC" : symbol}
							</button>
						))}
					</div>
				</div>

				<div className="bg-surface border border-border rounded-[18px] p-5 mb-5 shadow-e1">
					<div className="seg-track seg-track-block mb-4">
						{(["address", "username"] as const).map((t) => (
							<button
								key={t}
								onClick={() => {
									setDestType(t);
									setManualWallet("");
								}}
								data-active={destType === t}
								className="seg-item"
							>
								{t === "address" ? "Wallet" : "Usuario"}
							</button>
						))}
					</div>
					<input
						type="text"
						placeholder={destType === "address" ? "0x…" : "tunombre"}
						value={manualWallet}
						onChange={(e) =>
							setManualWallet(
								destType === "username" ? e.target.value.replace(/[^a-z0-9_-]/gi, "").toLowerCase() : e.target.value.trim(),
							)
						}
						className={`w-full bg-bg border border-border rounded-[12px] px-3.5 h-12 text-[14px] text-text placeholder:text-text-faint focus:border-border-strong transition-colors ${destType === "address" ? "font-mono" : ""}`}
					/>
				</div>

				{error && <p className="text-glow-pink text-[13px] text-center mb-4">{error}</p>}

				{!user ? (
					<button onClick={handleLogin} className="btn btn-primary btn-block">
						Inicia sesión para pagar
					</button>
				) : (
					<button
						onClick={handleManualPay}
						disabled={paying || resolvingUsername || !manualWallet || !payAmount}
						className="btn btn-gradient btn-block"
					>
						{resolvingUsername ? "Buscando usuario…" : "Pagar"}
					</button>
				)}
			</div>
		);
	}

	if (!linkData) return null;

	const isStoredLink = !["direct", "username", "manual"].includes(linkData.id);
	const hasFixedAmount = Number(linkData.amount) > 0;
	const recipientLabel = linkData.username
		? `@${linkData.username}`
		: linkData.wallet
		? `${linkData.wallet.slice(0, 6)}…${linkData.wallet.slice(-4)}`
		: "esta cuenta";

	// Username profile page
	if (username && userProfile && !showPayForm) {
		return (
			<div className={screen}>
				<header className="flex items-center gap-3 mb-6">
					<BackButton onClick={() => navigate(-1)} />
				</header>
				<div className="flex-1 flex flex-col items-center justify-center text-center animate-fade-up">
					<div className="w-20 h-20 rounded-full bg-pink/15 flex items-center justify-center font-display text-[32px] text-glow-pink uppercase mb-5">
						{userProfile.username[0]}
					</div>
					<h1 className="font-display text-[28px] mb-1">@{userProfile.username}</h1>
					<p className="text-[14px] text-text-muted">Recibe pagos en {activeNetwork.name}</p>
				</div>
				<button
					onClick={() => (user ? setShowPayForm(true) : handleLogin())}
					className="btn btn-primary btn-block"
				>
					{user ? `Pagar a @${userProfile.username}` : "Inicia sesión para pagar"}
				</button>
			</div>
		);
	}

	// Paid link
	if (linkData.status === "paid") {
		return (
			<div className={screen}>
				<header className="flex items-center gap-3 mb-6">
					<BackButton onClick={() => navigate("/")} />
				</header>
				<div className="flex-1 flex flex-col items-center justify-center text-center">
					<div className="w-16 h-16 rounded-full bg-sky/15 flex items-center justify-center mb-6 shadow-glow-sky">
						<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#9ce3f4" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
							<polyline points="20 6 9 17 4 12" />
						</svg>
					</div>
					<p className="text-[15px] text-text-muted mb-1">Este cobro ya fue pagado</p>
					<p className="font-display text-[40px] tabular">
						{linkData.amount}
						<span className="text-text-muted text-[20px] ml-1.5">{linkData.currency}</span>
					</p>
					{linkData.reference && <p className="text-text-muted text-[14px] mt-3">{linkData.reference}</p>}
				</div>
			</div>
		);
	}

	// Payment form (fixed link, open link, or username transfer)
	const isOpenAmount = !hasFixedAmount;

	return (
		<div className={screen}>
			<PayingOverlay stage={payStage} />
			<header className="flex items-center gap-3 mb-6">
				<BackButton onClick={() => (showPayForm ? setShowPayForm(false) : navigate(-1))} />
			</header>

			<TrustBadge />
			<Recipient label={recipientLabel} />

			{/* Amount */}
			<div className="flex flex-col items-center mb-6">
				{hasFixedAmount ? (
					<p className="font-display text-[56px] leading-none tabular">
						{linkData.amount}
						<span className="text-text-muted text-[24px] ml-2">{linkData.currency}</span>
					</p>
				) : (
					<>
						<input
							type="number"
							placeholder="0"
							value={payAmount}
							onChange={(e) => setPayAmount(e.target.value)}
							step="any"
							min="0"
							inputMode="decimal"
							autoFocus
							className={bigInput}
						/>
						<div className="seg-track mt-4">
							{(["USDC", "ETH"] as const).map((c) => {
								// Stored links fix the currency; only direct/username let you choose.
								const fixed = isStoredLink;
								const value = fixed ? linkData.currency : payCurrency;
								return (
									<button
										key={c}
										disabled={fixed && c !== linkData.currency}
										onClick={() => !fixed && setPayCurrency(c)}
										data-active={value === c}
										className={`seg-item ${fixed && c !== linkData.currency ? "opacity-30" : ""}`}
									>
										{c === "USDC" ? "USDC" : symbol}
									</button>
								);
							})}
						</div>
						<p className="text-[12px] text-text-faint mt-3">Elige la moneda y escribe el monto.</p>
					</>
				)}
			</div>

			{linkData.reference && (
				<p className="text-text-muted text-[14px] text-center mb-6 px-4 leading-relaxed">
					{linkData.reference}
				</p>
			)}

			<p className="text-[12px] text-text-faint text-center mb-5">Sin comisiones de red</p>

			{error && <p className="text-glow-pink text-[13px] text-center mb-4">{error}</p>}

			{!user ? (
				<button onClick={handleLogin} className="btn btn-primary btn-block">
					Inicia sesión para pagar
				</button>
			) : (
				<button
					onClick={handlePay}
					disabled={paying || (isOpenAmount && !payAmount)}
					className="btn btn-gradient btn-block"
				>
					Pagar
				</button>
			)}
			{slowConnection && paying && (
				<p className="text-text-faint text-[12px] text-center mt-3 animate-fade-in">
					La red está tardando un poco, no cierres esta pantalla…
				</p>
			)}
		</div>
	);
}

import { useState, useRef } from "react";
import { QRCodeSVG } from "qrcode.react";
import { sileo } from "sileo";
import type { User } from "../firebase";
import Logo from "../components/Logo";
import { fetchWithAuth } from "../authFetch";
import { activeNetwork } from "../network";
import { useViewTransitionNavigate } from "../useNav";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";
const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.me";

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

export default function CreateLink({ user }: { user: User }) {
	const navigate = useViewTransitionNavigate();
	const [step, setStep] = useState<"form" | "result">("form");
	const [amount, setAmount] = useState("");
	const [currency, setCurrency] = useState("USDC");
	const [reference, setReference] = useState("");
	const [loading, setLoading] = useState(false);
	const [paymentUrl, setPaymentUrl] = useState("");
	const cardRef = useRef<HTMLDivElement>(null);

	const symbol = activeNetwork.nativeTokenSymbol;

	async function handleCreate() {
		setLoading(true);
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/links`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ amount, currency, reference }),
			});
			if (!res.ok) {
				const data = await res.json().catch(() => ({ error: "No se pudo crear el link" }));
				throw new Error(data.error || "No se pudo crear el link");
			}
			const data = await res.json();
			setPaymentUrl(`${APP_URL}/pay?id=${data.id}`);
			setStep("result");
		} catch (err) {
			sileo.error({
				title: "No se pudo crear el link",
				description: err instanceof Error ? err.message : "Intenta de nuevo",
			});
		} finally {
			setLoading(false);
		}
	}

	async function captureCard(): Promise<Blob | null> {
		if (!cardRef.current) return null;
		const { toPng } = await import("html-to-image");
								const dataUrl = await toPng(cardRef.current, {
			backgroundColor: "#0A0A0B",
			width: cardRef.current.offsetWidth + 80,
			height: cardRef.current.offsetHeight + 80,
			style: { flex: "none", padding: "40px", margin: "0", maxWidth: "none" },
			pixelRatio: 2,
		});
		return (await fetch(dataUrl)).blob();
	}

	// Compartir = imagen del QR + el link de pago.
	async function handleShare() {
		try {
			const blob = await captureCard();
			const file = blob ? new File([blob], "parmelia-cobro.png", { type: "image/png" }) : null;
			if (file && navigator.canShare?.({ files: [file] })) {
				await navigator.share({
					title: "Cóbrame con Parmelia",
					text: `Págame con Parmelia: ${paymentUrl}`,
					files: [file],
				});
			} else if (navigator.share) {
				await navigator.share({ title: "Cobro Parmelia", text: "Págame con Parmelia", url: paymentUrl });
			} else {
				navigator.clipboard.writeText(paymentUrl);
				sileo.success({ title: "Link copiado" });
			}
		} catch {
			/* user cancelled */
		}
	}

	// Descargar = solo la imagen del QR.
	async function handleDownload() {
		try {
			const blob = await captureCard();
			if (!blob) return;
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.download = `parmelia-cobro-${amount || "abierto"}-${currency}.png`;
			a.href = url;
			a.click();
			URL.revokeObjectURL(url);
		} catch {
			sileo.error({ title: "No se pudo descargar" });
		}
	}

	// Copiar = solo el link.
	function handleCopy() {
		navigator.clipboard.writeText(paymentUrl);
		sileo.success({ title: "Link copiado" });
	}

	if (step === "result") {
		return (
			<div className="flex flex-col min-h-dvh px-5 pt-6 pb-10 w-full max-w-[460px] mx-auto animate-fade-up">
				<header className="flex items-center gap-3 mb-6">
					<BackButton onClick={() => navigate("/")} />
					<h1 className="text-[22px]">Tu link de cobro</h1>
				</header>

				<div className="flex-1 flex flex-col justify-center">
					<div
						ref={cardRef}
						className="relative overflow-hidden bg-surface border border-border rounded-[24px] p-7 flex flex-col items-center shadow-e2"
					>
						<div
							className="absolute top-0 left-0 right-0 h-1"
							style={{ background: "linear-gradient(100deg,#9ce3f4,#f4a9cf 52%,#efe08c)" }}
						/>
						<div
							className="pointer-events-none absolute -top-20 -right-16 w-48 h-48 rounded-full opacity-[0.14] blur-2xl"
							style={{ background: "radial-gradient(circle,#9ce3f4,transparent 70%)" }}
						/>

						<div className="flex items-center gap-2 mb-6 relative z-1">
							<Logo className="w-6" />
							<span className="font-display text-[16px]">Parmelia</span>
						</div>

						<div className="bg-white rounded-[18px] p-5 mb-6 shadow-e2 relative z-1">
							<QRCodeSVG value={paymentUrl} size={216} bgColor="#ffffff" fgColor="#0A0A0B" level="M" />
						</div>

						{Number(amount) > 0 ? (
							<p className="font-display text-[34px] leading-none tabular mb-2 relative z-1">
								{amount}
								<span className="text-text-muted text-[18px] ml-1.5">{currency}</span>
							</p>
						) : (
							<p className="font-display text-[24px] text-glow-pink mb-2 relative z-1">Monto abierto</p>
						)}

						{reference && (
							<p className="text-text-muted text-[14px] text-center leading-relaxed px-2 relative z-1">
								{reference}
							</p>
						)}
						<p className="text-[12px] text-text-faint mt-5 relative z-1">
							parmelia.me · Pago seguro en {activeNetwork.name}
						</p>
					</div>
				</div>

				<button onClick={handleShare} className="btn btn-primary btn-block mt-6">
					Compartir
				</button>
				<div className="flex gap-3 mt-3">
					<button onClick={handleDownload} className="btn btn-ghost flex-1">
						Descargar QR
					</button>
					<button onClick={handleCopy} className="btn btn-ghost flex-1">
						Copiar link
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-col min-h-dvh px-5 pt-6 pb-10 w-full max-w-[460px] mx-auto animate-fade-up">
			<header className="flex items-center gap-3 mb-7">
				<BackButton onClick={() => navigate("/")} />
				<h1 className="text-[22px]">Cobrar</h1>
			</header>

			{/* Amount — big input */}
			<div className="flex flex-col items-center mt-6 mb-8">
				<input
					type="number"
					placeholder="0"
					value={amount}
					onChange={(e) => setAmount(e.target.value)}
					step="any"
					min="0"
					inputMode="decimal"
					autoFocus
					className="w-full max-w-[260px] bg-transparent text-center font-display text-[60px] leading-none text-text placeholder:text-text-faint tabular"
				/>
				<div className="seg-track mt-4">
					{(["USDC", "ETH"] as const).map((c) => (
						<button key={c} onClick={() => setCurrency(c)} data-active={currency === c} className="seg-item">
							{c === "USDC" ? "USDC" : symbol}
						</button>
					))}
				</div>
				<p className="text-[12px] text-text-faint mt-4">
					Deja el monto en 0 para un cobro de monto abierto.
				</p>
			</div>

			{/* Reference */}
			<div className="bg-surface border border-border rounded-[18px] p-5 mb-6 shadow-e1">
				<label className="text-[13px] text-text-muted mb-2 block">Referencia (opcional)</label>
				<textarea
					placeholder="¿Por qué cobras? Ej: Diseño de logo"
					value={reference}
					onChange={(e) => setReference(e.target.value)}
					maxLength={200}
					rows={2}
					className="w-full bg-bg border border-border rounded-[12px] px-3.5 py-3 text-[14px] text-text placeholder:text-text-faint resize-none focus:border-border-strong transition-colors"
				/>
			</div>

			<button onClick={handleCreate} disabled={loading} className="btn btn-primary btn-block">
				{loading ? "Creando…" : "Crear link de cobro"}
			</button>
		</div>
	);
}

import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { sileo } from "sileo";
import { toPng } from "html-to-image";
import type { User } from "../firebase";
import Logo from "../components/Logo";
import { fetchWithAuth } from "../authFetch";
import { activeNetwork } from "../network";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";
const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.me";

export default function CreateLink({ user }: { user: User }) {
	const navigate = useNavigate();
	const [step, setStep] = useState<"form" | "result">("form");
	const [amount, setAmount] = useState("");
	const [currency, setCurrency] = useState("USDC");
	const [reference, setReference] = useState("");
	const [loading, setLoading] = useState(false);
	const [paymentUrl, setPaymentUrl] = useState("");
	const cardRef = useRef<HTMLDivElement>(null);

	async function handleCreate() {
		setLoading(true);
		try {
			const res = await fetchWithAuth(user, `${SERVER_URL}/links`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ amount, currency, reference }),
			});

			if (!res.ok) {
				const data = await res.json().catch(() => ({ error: "Failed to create link" }));
				throw new Error(data.error || "Failed to create link");
			}

			const data = await res.json();
			setPaymentUrl(`${APP_URL}/pay?id=${data.id}`);
			setStep("result");
		} catch (err) {
			sileo.error({ title: "Error", description: err instanceof Error ? err.message : "Error al crear link" });
		} finally {
			setLoading(false);
		}
	}

	if (step === "result") {
		return (
			<div className="flex flex-col min-h-dvh px-5 sm:px-8 pt-6 sm:pt-10 pb-8 w-full max-w-lg mx-auto">
				{/* Header */}
				<div className="flex items-center justify-between mb-6">
				<button
					onClick={() => navigate("/")}
					className="flex items-center gap-1.5 text-sm text-muted hover:text-white transition-colors"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
					</svg>
					Volver
				</button>
				</div>

				{/* QR Card */}
				<div ref={cardRef} className="flex-1 flex flex-col">
					<div className="bg-surface rounded-2xl p-6 sm:p-8 flex flex-col items-center flex-1 h-full relative">
						<Logo className="w-14 mb-6" />

						<div className="bg-white rounded-xl p-5 sm:p-6 mb-6 qr-card">
							<QRCodeSVG
								value={paymentUrl}
								size={220}
								bgColor="#ffffff"
								fgColor="#000000"
								level="M"
							/>
						</div>

						{Number(amount) > 0 ? (
							<p className="text-xl sm:text-2xl mb-3">{amount} {currency}</p>
						) : (
							<p className="text-xl sm:text-2xl mb-3 text-parmelia-pink">Monto abierto</p>
						)}

						{reference && (
							<p className="text-muted text-sm text-center px-6 leading-relaxed">
								{reference}
							</p>
						)}

						<p className="text-xs text-muted text-center mt-5">
							Red activa: {activeNetwork.name}
						</p>
					</div>
				</div>

				{/* Action buttons */}
				<div className="flex gap-3 mt-6">
					<button
						onClick={async () => {
							if (!cardRef.current) return;
							try {
								const dataUrl = await toPng(cardRef.current, {
									backgroundColor: '#000000',
									width: cardRef.current.offsetWidth + 64,
									height: cardRef.current.offsetHeight + 64,
									style: { 
										flex: 'none',
										padding: '32px',
										margin: '0',
										maxWidth: 'none'
									},
									pixelRatio: 2,
								});
								const a = document.createElement("a");
								a.download = `parmelia-${amount}-${currency}.png`;
								a.href = dataUrl;
								a.click();
							} catch {
								sileo.error({ title: "Error al descargar" });
							}
						}}
						className="flex-1 bg-parmelia-blue text-black py-3 rounded-full text-sm font-medium"
					>
						Descargar
					</button>
					<button
						onClick={() => {
							if (navigator.share) {
								navigator.share({ title: "Parmelia Payment", url: paymentUrl });
							} else {
								navigator.clipboard.writeText(paymentUrl);
								sileo.success({ title: "Link copiado" });
							}
						}}
						className="flex-1 bg-parmelia-gold text-black py-3 rounded-full text-sm font-medium"
					>
						Compartir
					</button>
				</div>
				<button
					onClick={() => {
						navigator.clipboard.writeText(paymentUrl);
						sileo.success({ title: "Link copiado" });
					}}
					className="w-full text-center text-sm text-parmelia-blue underline mt-5"
				>
					Copiar link de pago
				</button>
			</div>
		);
	}

	return (
		<div className="flex flex-col min-h-dvh px-5 sm:px-8 pt-6 sm:pt-10 pb-8 w-full max-w-lg mx-auto">
			{/* Header */}
			<div className="flex items-center justify-between mb-6">
				<button
					onClick={() => navigate("/")}
					className="flex items-center gap-1.5 text-sm text-muted hover:text-white transition-colors"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
					</svg>
					Volver
				</button>
			</div>

			{/* Form card */}
			<div className="bg-surface rounded-2xl p-5 sm:p-6 mb-6">
				<div className="mb-5">
					<label className="text-sm text-muted mb-2 block">Red activa</label>
					<div className="w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm">
						{activeNetwork.name}
					</div>
					<p className="text-xs text-muted mt-2 leading-relaxed">
						Por ahora cada link usa una sola red activa. El selector multi-chain
						llegará después del MVP.
					</p>
				</div>

				<div className="mb-5">
					<label className="text-sm text-muted mb-2 block">Moneda</label>
					<select
						value={currency}
						onChange={(e) => setCurrency(e.target.value)}
						className="w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm"
					>
						<option value="USDC">USDC</option>
						<option value="ETH">{activeNetwork.nativeTokenSymbol}</option>
					</select>
				</div>

				<div className="mb-5">
					<label className="text-sm text-muted mb-2 block">Monto</label>
					<input
						type="number"
						placeholder="0.00"
						value={amount}
						onChange={(e) => setAmount(e.target.value)}
						step="any"
						min="0"
						inputMode="decimal"
						className="w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm"
					/>
				</div>

				<div>
					<label className="text-sm text-muted mb-2 block">Referencia</label>
					<textarea
						placeholder=""
						value={reference}
						onChange={(e) => setReference(e.target.value)}
						maxLength={200}
						rows={3}
						className="w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm resize-none"
					/>
				</div>
			</div>

			{/* Cobrar button */}
			<div className="flex justify-center">
				<button
					onClick={handleCreate}
					disabled={loading}
					className="bg-parmelia-pink text-black px-12 py-3 rounded-full text-sm font-medium disabled:opacity-50 transition-opacity"
				>
					{loading ? "Creando..." : "Cobrar"}
				</button>
			</div>
		</div>
	);
}

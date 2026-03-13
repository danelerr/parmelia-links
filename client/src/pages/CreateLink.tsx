import { useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { QRCodeSVG } from "qrcode.react";
import { sileo } from "sileo";
import { toPng } from "html-to-image";
import type { User } from "../firebase";
import Logo from "../components/Logo";
import { fetchWithAuth } from "../authFetch";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";
const APP_URL = import.meta.env.VITE_APP_URL || "https://parmelia.vercel.app";

export default function CreateLink({ user }: { user: User }) {
	const navigate = useNavigate();
	const [step, setStep] = useState<"form" | "result">("form");
	const [amount, setAmount] = useState("");
	const [currency, setCurrency] = useState("USDC");
	const [network, setNetwork] = useState("Base Sepolia");
	const [reference, setReference] = useState("");
	const [loading, setLoading] = useState(false);
	const [paymentUrl, setPaymentUrl] = useState("");
	const cardRef = useRef<HTMLDivElement>(null);

	async function handleCreate() {
		if (!amount) return;
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
					<div className="flex items-center gap-2">
						<Logo className="w-7" />
						<span className="text-sm text-parmelia-blue">Parmelia</span>
					</div>
					<button
						onClick={() => navigate("/")}
						className="w-10 h-10 rounded-full bg-parmelia-pink flex items-center justify-center text-black text-sm"
					>
						···
					</button>
				</div>

				{/* QR Card */}
				<div ref={cardRef} className="bg-surface rounded-2xl p-6 sm:p-8 flex flex-col items-center flex-1">
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

					<p className="text-xl sm:text-2xl mb-3">{amount} {currency}</p>
					{reference && (
						<p className="text-muted text-sm text-center px-6 leading-relaxed">
							{reference}
						</p>
					)}
				</div>

				{/* Action buttons */}
				<div className="flex gap-3 mt-6">
					<button
						onClick={async () => {
							if (!cardRef.current) return;
							try {
								const dataUrl = await toPng(cardRef.current, {
									style: { flex: 'none' },
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
				<button
					onClick={() => navigate("/")}
					className="w-10 h-10 rounded-full bg-parmelia-pink flex items-center justify-center text-black text-sm"
				>
					···
				</button>
			</div>

			{/* Form card */}
			<div className="bg-surface rounded-2xl p-5 sm:p-6 mb-6">
				<div className="mb-5">
					<label className="text-sm text-muted mb-2 block">Red</label>
					<select
						value={network}
						onChange={(e) => setNetwork(e.target.value)}
						className="w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm"
					>
						<option value="Base Sepolia">Base Sepolia</option>
					</select>
				</div>

				<div className="mb-5">
					<label className="text-sm text-muted mb-2 block">Moneda</label>
					<select
						value={currency}
						onChange={(e) => setCurrency(e.target.value)}
						className="w-full bg-white/90 text-black rounded-xl px-4 py-3 text-sm"
					>
						<option value="USDC">USDC</option>
						<option value="ETH">ETH</option>
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
					disabled={loading || !amount}
					className="bg-parmelia-pink text-black px-12 py-3 rounded-full text-sm font-medium disabled:opacity-50 transition-opacity"
				>
					{loading ? "Creando..." : "Cobrar"}
				</button>
			</div>
		</div>
	);
}

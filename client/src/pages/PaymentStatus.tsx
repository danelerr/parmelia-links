import { useSearchParams, useNavigate } from "react-router-dom";
import { useRef } from "react";
import { toPng } from "html-to-image";
import Logo from "../components/Logo";

export default function PaymentStatus() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const cardRef = useRef<HTMLDivElement>(null);
	const txHash = searchParams.get("tx");
	const amount = searchParams.get("amount");
	const currency = searchParams.get("currency");
	const to = searchParams.get("to");

	async function captureCard() {
		if (!cardRef.current) return null;
		return toPng(cardRef.current, {
			style: { flex: 'none' },
			pixelRatio: 2,
		});
	}

	async function handleDownload() {
		try {
			const dataUrl = await captureCard();
			if (!dataUrl) return;
			const a = document.createElement("a");
			a.download = `parmelia-pago-${amount}-${currency}.png`;
			a.href = dataUrl;
			a.click();
		} catch {
			// ignore
		}
	}

	return (
		<div className="flex flex-col min-h-dvh px-5 sm:px-8 pt-6 sm:pt-10 pb-12 w-full max-w-lg mx-auto">
			{/* Header */}
			<div className="flex items-center justify-between mb-8">
				<button
					onClick={() => navigate("/")}
					className="flex items-center gap-1.5 text-sm text-muted hover:text-white transition-colors"
				>
					<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
					</svg>
					Inicio
				</button>
				<div className="flex items-center gap-2">
					<Logo className="w-7" />
				</div>
			</div>

			{/* Success card */}
			<div ref={cardRef} className="bg-surface rounded-2xl p-8 sm:p-10 flex-1 flex flex-col items-center justify-center">
				<Logo className="w-16 mb-8" />

				<h2 className="text-4xl sm:text-5xl mb-4">Pagaste</h2>

				{amount && (
					<p className="text-xl mb-3">{amount} {currency}</p>
				)}

				{to && (
					<p className="text-muted text-sm mb-8">A {to}</p>
				)}

				{/* Check icon */}
				<div className="w-16 h-16 rounded-full bg-muted/30 flex items-center justify-center">
					<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
						<polyline points="20 6 9 17 4 12" />
					</svg>
				</div>

				{txHash && (
					<a
						href={`https://base-sepolia.blockscout.com/tx/${txHash}`}
						target="_blank"
						rel="noopener noreferrer"
						className="text-parmelia-blue text-sm underline mt-4"
					>
						Comprobante onchain ↗
					</a>
				)}
			</div>

			{/* Action buttons */}
			<div className="flex gap-3 mt-6">
				<button
					onClick={handleDownload}
					className="flex-1 bg-parmelia-blue text-black py-3 rounded-full text-sm font-medium"
				>
					Descargar
				</button>
				<button
					onClick={async () => {
						try {
							const dataUrl = await captureCard();
							if (!dataUrl) return;
							const res = await fetch(dataUrl);
							const blob = await res.blob();
							const file = new File([blob], `parmelia-pago-${amount}-${currency}.png`, { type: "image/png" });
							if (navigator.share && navigator.canShare?.({ files: [file] })) {
								await navigator.share({
									title: "Pago Parmelia",
									text: `Pagué ${amount} ${currency}`,
									files: [file],
								});
							} else if (navigator.share && txHash) {
								await navigator.share({
									title: "Pago Parmelia",
									text: `Pagué ${amount} ${currency}`,
									url: `https://base-sepolia.blockscout.com/tx/${txHash}`,
								});
							}
						} catch {
							// User cancelled or not supported
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

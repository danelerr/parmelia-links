import { useSearchParams } from "react-router-dom";
import { useRef } from "react";
import Logo from "../components/Logo";
import { activeNetwork, getExplorerTxUrl } from "../network";
import { useViewTransitionNavigate } from "../useNav";

export default function PaymentStatus() {
	const [searchParams] = useSearchParams();
	const navigate = useViewTransitionNavigate();
	const cardRef = useRef<HTMLDivElement>(null);
	const txHash = searchParams.get("tx");
	const amount = searchParams.get("amount");
	const currency = searchParams.get("currency");
	const to = searchParams.get("to");

	const toLabel = to
		? to.startsWith("0x")
			? `${to.slice(0, 6)}…${to.slice(-4)}`
			: `@${to}`
		: null;

	async function captureCard() {
		if (!cardRef.current) return null;
		const { toPng } = await import("html-to-image");
		return toPng(cardRef.current, {
			backgroundColor: "#0A0A0B",
			width: cardRef.current.offsetWidth + 64,
			height: cardRef.current.offsetHeight + 64,
			style: { flex: "none", padding: "32px", margin: "0", maxWidth: "none" },
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
			/* ignore */
		}
	}

	async function handleShare() {
		try {
			const dataUrl = await captureCard();
			if (!dataUrl) return;
			const res = await fetch(dataUrl);
			const blob = await res.blob();
			const file = new File([blob], `parmelia-pago-${amount}-${currency}.png`, { type: "image/png" });
			if (navigator.share && navigator.canShare?.({ files: [file] })) {
				await navigator.share({ title: "Pago Parmelia", text: `Pagué ${amount} ${currency}`, files: [file] });
			} else if (navigator.share && txHash) {
				await navigator.share({ title: "Pago Parmelia", text: `Pagué ${amount} ${currency}`, url: getExplorerTxUrl(txHash) });
			}
		} catch {
			/* user cancelled or unsupported */
		}
	}

	return (
		<div className="flex flex-col min-h-dvh px-5 pt-6 pb-10 w-full max-w-[460px] mx-auto animate-fade-up">
			<div className="flex-1 flex flex-col justify-center">
				<div
					ref={cardRef}
					className="relative overflow-hidden bg-surface border border-border rounded-[24px] p-8 flex flex-col items-center shadow-e2"
				>
					<div
						className="absolute top-0 left-0 right-0 h-1"
						style={{ background: "linear-gradient(100deg,#9ce3f4,#f4a9cf 52%,#efe08c)" }}
					/>
					<div
						className="pointer-events-none absolute -top-20 -left-16 w-48 h-48 rounded-full opacity-[0.14] blur-2xl"
						style={{ background: "radial-gradient(circle,#9ce3f4,transparent 70%)" }}
					/>

					<div className="flex items-center gap-2 mb-6 relative z-1">
						<Logo className="w-6" />
						<span className="font-display text-[16px]">Parmelia</span>
					</div>

					{/* Success check */}
					<div className="w-16 h-16 rounded-full bg-sky/15 flex items-center justify-center mb-6 shadow-glow-sky relative z-1">
						<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#9ce3f4" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
							<polyline points="20 6 9 17 4 12" />
						</svg>
					</div>

					<p className="text-[15px] text-text-muted mb-1 relative z-1">¡Listo! Pagaste</p>
					{amount && (
						<p className="font-display text-[44px] leading-none mb-4 tabular relative z-1">
							{amount}
							<span className="text-text-muted text-[22px] ml-1.5">{currency}</span>
						</p>
					)}

					{toLabel && (
						<p className="text-text-faint text-[13px] mb-1 relative z-1">
							Para <span className="text-text-muted">{toLabel}</span>
						</p>
					)}
					<p className="text-[12px] text-text-faint relative z-1">
						parmelia.me · Asegurado en {activeNetwork.name}
					</p>

					{txHash && (
						<a
							href={getExplorerTxUrl(txHash)}
							target="_blank"
							rel="noopener noreferrer"
							className="text-text-faint text-[12px] mt-4 relative z-1"
						>
							Ver comprobante en la red ↗
						</a>
					)}
				</div>
			</div>

			<div className="flex gap-3 mt-6">
				<button onClick={handleShare} className="btn btn-primary flex-1">
					Compartir
				</button>
				<button onClick={handleDownload} className="btn btn-ghost">
					Descargar
				</button>
			</div>
			<button onClick={() => navigate("/")} className="btn-text w-full mt-3">
				Volver al inicio
			</button>
		</div>
	);
}

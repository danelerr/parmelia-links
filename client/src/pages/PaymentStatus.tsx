import { useSearchParams } from "react-router-dom";
import { useRef } from "react";
import Logo from "../components/Logo";
import { activeNetwork, getExplorerTxUrl } from "../lib/activeNetwork";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { downloadCard, shareCard } from "../lib/exportCard";

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

	async function handleDownload() {
		try {
			await downloadCard(cardRef.current, `parmelia-pago-${amount}-${currency}.png`);
		} catch {
			/* ignore */
		}
	}

	async function handleShare() {
		await shareCard(cardRef.current, {
			filename: `parmelia-pago-${amount}-${currency}.png`,
			text: `Pagué ${amount} ${currency} con Parmelia`,
			url: txHash ? getExplorerTxUrl(txHash) : undefined,
		});
	}

	return (
		<div className="flex flex-col min-h-dvh px-5 pt-[calc(env(safe-area-inset-top)_+_1.5rem)] pb-[calc(env(safe-area-inset-bottom)_+_2.5rem)] w-full max-w-[460px] mx-auto animate-fade-up">
			<header className="flex items-center">
				<button
					onClick={() => navigate("/")}
					aria-label="Volver al inicio"
					className="w-10 h-10 -ml-1 rounded-full flex items-center justify-center text-text-muted hover:text-text hover:bg-surface transition-colors"
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M19 12H5" />
						<path d="M12 19l-7-7 7-7" />
					</svg>
				</button>
			</header>
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
						Asegurado en {activeNetwork.name}
					</p>

					{/* Formal receipt info */}
					<div className="w-full border-t border-border mt-5 pt-4 relative z-1 flex flex-col gap-1.5">
						<div className="flex items-center justify-between text-[12px]">
							<span className="text-text-faint">Fecha</span>
							<span className="text-text-muted">
								{new Date().toLocaleDateString("es", { day: "numeric", month: "long", year: "numeric" })}
							</span>
						</div>
						<div className="flex items-center justify-between text-[12px]">
							<span className="text-text-faint">Hora</span>
							<span className="text-text-muted">
								{new Date().toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })}
							</span>
						</div>
						{txHash && (
							<div className="flex items-center justify-between text-[12px] gap-3">
								<span className="text-text-faint shrink-0">N° de comprobante</span>
								<span className="text-text-muted font-mono truncate">
									{txHash.slice(0, 10)}…{txHash.slice(-8)}
								</span>
							</div>
						)}
						<p className="text-[11px] text-text-faint text-center mt-2">parmelia.me</p>
					</div>

					{txHash && (
						<a
							href={getExplorerTxUrl(txHash)}
							target="_blank"
							rel="noopener noreferrer"
							className="text-text-faint text-[12px] mt-3 relative z-1"
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
		</div>
	);
}

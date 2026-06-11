// Move money between networks (cross-chain MVP, USDC).
// Deposits: quote in-app → continue on Across (our bridge partner) with the
// user's Parmelia account prefilled as recipient — funds land directly here.
// Withdrawals: quoted; execution ships next (signed with the passkey).

import { useEffect, useRef, useState } from "react";
import type { User } from "../lib/firebase";
import { fetchWithAuth } from "../lib/authFetch";
import Logo from "../components/Logo";
import { activeNetwork } from "../lib/activeNetwork";
import { useViewTransitionNavigate } from "../hooks/useNav";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";

type BridgeChain = { id: number; key: string; name: string };
type Direction = "deposit" | "withdraw";

type BridgeQuote = {
	amountIn: string;
	bridgeFee: string;
	parmeliaFee: string;
	amountOutEstimated: string;
	estimatedMinutes: number;
	acrossUrl: string | null;
};

export default function Deposit({ user }: { user: User }) {
	const navigate = useViewTransitionNavigate();
	const [enabled, setEnabled] = useState<boolean | null>(null);
	const [chains, setChains] = useState<BridgeChain[]>([]);
	const [direction, setDirection] = useState<Direction>("deposit");
	const [chainId, setChainId] = useState<number | null>(null);
	const [amount, setAmount] = useState("");
	const [quote, setQuote] = useState<BridgeQuote | null>(null);
	const [quoting, setQuoting] = useState(false);
	const [error, setError] = useState("");
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		(async () => {
			try {
				const res = await fetchWithAuth(user, `${SERVER_URL}/bridge/config`);
				if (!res.ok) throw new Error();
				const data = await res.json();
				setEnabled(!!data.enabled);
				setChains(data.chains || []);
				if (data.chains?.length) setChainId(data.chains[0].id);
			} catch {
				setEnabled(false);
			}
		})();
	}, [user]);

	useEffect(() => {
		setQuote(null);
		setError("");
		if (debounceRef.current) clearTimeout(debounceRef.current);
		const value = Number(amount);
		if (!enabled || !chainId || !amount || !Number.isFinite(value) || value <= 0) return;

		debounceRef.current = setTimeout(async () => {
			setQuoting(true);
			try {
				const res = await fetchWithAuth(user, `${SERVER_URL}/bridge/quote`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ direction, chainId, amount }),
				});
				const data = await res.json();
				if (!res.ok) throw new Error(data.error || "No pudimos cotizar");
				setQuote(data as BridgeQuote);
			} catch (err) {
				setError(err instanceof Error ? err.message : "No pudimos cotizar");
			} finally {
				setQuoting(false);
			}
		}, 500);

		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [user, enabled, direction, chainId, amount]);

	const externalChainName = chains.find((c) => c.id === chainId)?.name ?? "";

	return (
		<div className="flex flex-col min-h-dvh px-5 pt-6 pb-10 w-full max-w-[460px] mx-auto animate-fade-up">
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
				<h1 className="text-[22px]">Mover entre redes</h1>
			</header>

			{enabled === null ? (
				<div className="flex-1 flex items-center justify-center">
					<div className="w-6 h-6 border-2 border-surface-2 border-t-sky rounded-full animate-spin" />
				</div>
			) : !enabled ? (
				<div className="flex-1 flex flex-col items-center justify-center text-center px-6">
					<Logo className="w-12 mb-5 opacity-40" />
					<p className="text-[15px] text-text mb-1">Disponible muy pronto</p>
					<p className="text-[13px] text-text-muted max-w-[280px] leading-relaxed">
						Mover dinero entre redes se activa con el lanzamiento en {"Arbitrum"}.
						Por ahora estás en {activeNetwork.name}.
					</p>
				</div>
			) : (
				<>
					{/* Direction */}
					<div className="seg-track seg-track-block mb-5">
						{(
							[
								["deposit", "Depositar"],
								["withdraw", "Retirar"],
							] as const
						).map(([value, label]) => (
							<button
								key={value}
								onClick={() => setDirection(value)}
								data-active={direction === value}
								className="seg-item"
							>
								{label}
							</button>
						))}
					</div>

					{/* Network */}
					<p className="text-[13px] text-text-muted px-1 mb-2">
						{direction === "deposit" ? "Desde la red" : "Hacia la red"}
					</p>
					<div className="flex gap-1.5 mb-5 overflow-x-auto -mx-1 px-1 pb-1">
						{chains.map((chain) => (
							<button
								key={chain.id}
								onClick={() => setChainId(chain.id)}
								className={`shrink-0 px-4 h-10 rounded-full text-[13px] font-medium border transition-colors ${
									chainId === chain.id
										? "bg-sky/18 text-glow-sky border-sky/30"
										: "text-text-muted border-border hover:text-text"
								}`}
							>
								{chain.name}
							</button>
						))}
					</div>

					{/* Amount (USDC) */}
					<div className="bg-surface border border-border rounded-[18px] p-5 mb-5 shadow-e1">
						<p className="text-[13px] text-text-muted mb-3">
							{direction === "deposit"
								? `Monto a traer desde ${externalChainName}`
								: `Monto a enviar a ${externalChainName}`}
						</p>
						<div className="flex items-center gap-3">
							<input
								type="number"
								placeholder="0"
								value={amount}
								onChange={(e) => setAmount(e.target.value)}
								step="any"
								min="0"
								inputMode="decimal"
								autoFocus
								className="flex-1 min-w-0 bg-transparent font-display text-[34px] leading-none text-text placeholder:text-text-faint tabular"
							/>
							<span className="text-[15px] text-text-muted font-medium shrink-0">USDC</span>
						</div>
					</div>

					{error && <p className="text-glow-pink text-[13px] text-center mb-4">{error}</p>}
					{quoting && (
						<p className="text-[13px] text-text-muted text-center mb-4 animate-pulse-soft">
							Cotizando el mejor camino…
						</p>
					)}

					{quote && (
						<div className="bg-surface border border-border rounded-[18px] px-5 py-4 mb-5">
							<div className="flex items-center justify-between text-[14px] mb-2">
								<span className="text-text-muted">Recibirás aproximadamente</span>
								<span className="text-text font-medium tabular">
									{Number(quote.amountOutEstimated).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC
								</span>
							</div>
							<div className="flex items-center justify-between text-[13px] mb-1.5">
								<span className="text-text-muted">Costo del puente</span>
								<span className="text-text tabular">
									{Number(quote.bridgeFee).toLocaleString("en-US", { maximumFractionDigits: 4 })} USDC
								</span>
							</div>
							<div className="flex items-center justify-between text-[13px] mb-1.5">
								<span className="text-text-muted">Servicio Parmelia</span>
								<span className={Number(quote.parmeliaFee) > 0 ? "text-text tabular" : "text-glow-sky"}>
									{Number(quote.parmeliaFee) > 0 ? `${quote.parmeliaFee} USDC` : "Gratis"}
								</span>
							</div>
							<div className="flex items-center justify-between text-[13px]">
								<span className="text-text-muted">Tiempo estimado</span>
								<span className="text-text">~{quote.estimatedMinutes} min</span>
							</div>
						</div>
					)}

					<div className="flex-1" />

					{direction === "deposit" ? (
						<>
							<button
								onClick={() => quote?.acrossUrl && window.open(quote.acrossUrl, "_blank", "noopener")}
								disabled={!quote?.acrossUrl}
								className="btn btn-gradient btn-block"
							>
								Continuar
							</button>
							<p className="text-[12px] text-text-faint text-center mt-3 leading-relaxed">
								Completarás el depósito con Across, nuestro socio de puentes.
								Tu dinero llega directo a tu cuenta Parmelia.
							</p>
						</>
					) : (
						<>
							<button disabled className="btn btn-ghost btn-block">
								Retiros entre redes — muy pronto
							</button>
							<p className="text-[12px] text-text-faint text-center mt-3">
								Ya puedes ver el costo estimado; los retiros se activan en la próxima actualización.
							</p>
						</>
					)}
				</>
			)}
		</div>
	);
}

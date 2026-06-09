import { type User } from "../firebase";
import { useMemo, useState, useRef } from "react";
import useSWR from "swr";
import { fetchWithAuth } from "../authFetch";
import Logo from "../components/Logo";
import { activeNetwork, getExplorerTxUrl } from "../network";
import { useViewTransitionNavigate } from "../useNav";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";

interface Transaction {
	type: "sent" | "received";
	txHash: string;
	amount: string;
	currency: string;
	to?: string;
	reference?: string;
	createdAt: string;
}

function formatUsd(value: string | null) {
	if (value === null) return "0.00";
	const n = Number(value);
	if (!Number.isFinite(n)) return value;
	return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatNative(value: string | null) {
	if (value === null) return "0";
	const n = Number(value);
	if (!Number.isFinite(n)) return value;
	return n.toLocaleString("en-US", { maximumFractionDigits: 5 });
}

function formatDate(iso: string) {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString("es", { day: "numeric", month: "short" });
}

export default function Home({ user }: { user: User }) {
	const navigate = useViewTransitionNavigate();
	const [copied, setCopied] = useState(false);
	const [selectedCurrency, setSelectedCurrency] = useState<"USDC" | "ETH">("USDC");
	const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
	const txCardRef = useRef<HTMLDivElement>(null);

	const fetcher = async (url: string) => {
		const res = await fetchWithAuth(user, url);
		if (!res.ok) throw new Error("API error");
		return res.json();
	};

	const { data: profile } = useSWR(`${SERVER_URL}/user/profile`, fetcher, {
		revalidateOnFocus: true,
		revalidateOnReconnect: true,
	});

	const { data: balance, isLoading: isBalanceLoading } = useSWR(
		profile?.walletAddress ? `${SERVER_URL}/user/balance` : null,
		fetcher,
		{ refreshInterval: 10000, keepPreviousData: true },
	);

	const { data: txData, isLoading: isTxLoading } = useSWR(
		profile?.walletAddress ? `${SERVER_URL}/user/transactions` : null,
		fetcher,
		{ refreshInterval: 15000, keepPreviousData: true },
	);

	// Derived from polled data — memoize so the two maps + sort don't re-run on
	// every render (balance/tx poll on intervals, plus local UI state changes).
	const transactions: Transaction[] = useMemo(() => {
		if (!txData) return [];
		const sent = (txData.sent || []).map((t: any) => ({
			type: "sent" as const,
			txHash: t.txHash,
			amount: t.amount,
			currency: t.currency,
			to: t.to,
			createdAt: t.createdAt,
		}));
		const received = (txData.received || []).map((t: any) => ({
			type: "received" as const,
			txHash: t.txHash,
			amount: t.amount,
			currency: t.currency,
			reference: t.reference,
			createdAt: t.createdAt,
		}));
		return [...sent, ...received].sort(
			(a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
		);
	}, [txData]);

	const walletAddress = profile?.walletAddress || null;
	const username = profile?.username || null;
	const ethBalance = balance?.eth ?? null;
	const usdcBalance = balance?.usdc ?? null;
	const symbol = activeNetwork.nativeTokenSymbol;

	function handleCopyAddress() {
		if (!walletAddress) return;
		navigator.clipboard.writeText(walletAddress);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}

	const quickActions = [
		{ label: "Cobrar", to: "/cobrar", accent: "#f4a9cf", icon: <IconReceive /> },
		{ label: "Pagar", to: "/pagar", accent: "#9ce3f4", icon: <IconSend /> },
		{ label: "Escanear", to: "/scan", accent: "#efe08c", icon: <IconScan /> },
	];

	return (
		<div className="flex flex-col min-h-dvh px-5 pt-6 pb-12 w-full max-w-[460px] mx-auto animate-fade-up">
			{/* Top bar */}
			<header className="flex items-center justify-between mb-7">
				<div className="flex items-center gap-2.5">
					<Logo className="w-7" />
					<div className="leading-tight">
						<p className="font-display text-[15px]">Parmelia</p>
						<p className="text-[12px] text-text-faint">
							{username ? `@${username}` : activeNetwork.name}
						</p>
					</div>
				</div>
				<button
					onClick={() => navigate("/settings")}
					aria-label="Ajustes"
					className="w-10 h-10 rounded-full overflow-hidden border border-border flex items-center justify-center bg-surface hover:border-border-strong transition-colors"
				>
					{user.photoURL ? (
						<img src={user.photoURL} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
					) : (
						<span className="text-sm font-display text-sky uppercase">
							{(username || user.displayName || "?")[0]}
						</span>
					)}
				</button>
			</header>

			{/* Balance card */}
			<div className="relative overflow-hidden bg-surface border border-border rounded-[22px] p-6 mb-4 shadow-e2">
				<div
					className="pointer-events-none absolute -top-16 -right-10 w-48 h-48 rounded-full opacity-[0.18] blur-2xl"
					style={{ background: "radial-gradient(circle, #9ce3f4, transparent 70%)" }}
				/>
				{isBalanceLoading && !balance && (
					<div className="absolute inset-0 bg-surface z-10 flex items-center justify-center">
						<div className="w-6 h-6 border-2 border-sky border-t-transparent rounded-full animate-spin" />
					</div>
				)}

				{/* Currency segmented control */}
				<div className="flex justify-center mb-5 relative z-1">
					<div className="seg-track">
						{(["USDC", "ETH"] as const).map((c) => (
							<button
								key={c}
								onClick={() => setSelectedCurrency(c)}
								data-active={selectedCurrency === c}
								className="seg-item"
							>
								{c === "USDC" ? "USDC" : symbol}
							</button>
						))}
					</div>
				</div>

				<div className="flex flex-col items-center mb-5 relative z-1">
					<p className="text-[13px] text-text-muted mb-1">Tu saldo</p>
					{selectedCurrency === "USDC" ? (
						<p className="font-display text-[46px] leading-none tabular">
							<span className="text-text-muted text-[28px] align-top mr-0.5">$</span>
							{formatUsd(usdcBalance)}
						</p>
					) : (
						<p className="font-display text-[46px] leading-none tabular">
							{formatNative(ethBalance)}
							<span className="text-text-muted text-[20px] ml-2">{symbol}</span>
						</p>
					)}
				</div>

				<button
					onClick={handleCopyAddress}
					className="mx-auto flex items-center gap-2 px-3.5 py-2 rounded-full text-[12px] text-text-faint hover:text-text-muted hover:bg-surface-2 transition-colors relative z-1"
				>
					<span className="font-mono">
						{walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : "Cargando…"}
					</span>
					<span>{copied ? "Copiado ✓" : "Copiar"}</span>
				</button>
			</div>

			{/* Quick actions */}
			<div className="grid grid-cols-3 gap-3 mb-7">
				{quickActions.map((a) => (
					<button
						key={a.label}
						onClick={() => navigate(a.to)}
						className="flex flex-col items-center gap-2.5 py-4 bg-surface border border-border rounded-[18px] hover:border-border-strong hover:-translate-y-0.5 transition-all duration-200"
					>
						<span
							className="w-11 h-11 rounded-full flex items-center justify-center"
							style={{ background: `${a.accent}26`, color: a.accent }}
						>
							{a.icon}
						</span>
						<span className="text-[13px] font-medium">{a.label}</span>
					</button>
				))}
			</div>

			{/* Activity */}
			<div className="flex items-center justify-between mb-3 px-1">
				<h2 className="font-display text-[18px]">Actividad</h2>
				{isTxLoading && txData && (
					<span className="w-2 h-2 rounded-full bg-sky animate-pulse" />
				)}
			</div>

			<div className="flex-1">
				{isTxLoading && !txData ? (
					<div className="flex items-center justify-center py-16">
						<div className="w-5 h-5 border-2 border-surface-2 border-t-sky rounded-full animate-spin" />
					</div>
				) : transactions.length === 0 ? (
					<div className="flex flex-col items-center text-center py-14 px-6">
						<Logo className="w-12 mb-5 opacity-40" />
						<p className="text-[15px] text-text mb-1">Aún no hay movimientos</p>
						<p className="text-[13px] text-text-muted mb-6 max-w-[240px] leading-relaxed">
							Crea tu primer link de cobro y compártelo para recibir tu primer pago.
						</p>
						<button
							onClick={() => navigate("/cobrar")}
							className="btn btn-primary btn-sm"
						>
							Crear un link de cobro
						</button>
					</div>
				) : (
					<div className="flex flex-col gap-1">
						{transactions.map((tx, i) => {
							const received = tx.type === "received";
							return (
								<button
									key={tx.txHash + i}
									onClick={() => setSelectedTx(tx)}
									className="flex items-center gap-3.5 py-3 px-2 -mx-2 rounded-[14px] hover:bg-surface transition-colors text-left"
								>
									<span
										className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
											received ? "bg-sky/15 text-glow-sky" : "bg-surface-2 text-text-muted"
										}`}
									>
										{received ? <IconReceive small /> : <IconSend small />}
									</span>
									<div className="min-w-0 flex-1">
										<p className="text-[15px] truncate">
											{received ? tx.reference || "Cobro recibido" : "Pago enviado"}
										</p>
										<p className="text-[12px] text-text-faint">{formatDate(tx.createdAt)}</p>
									</div>
									<span
										className={`text-[15px] font-medium tabular shrink-0 ${
											received ? "text-glow-sky" : "text-text"
										}`}
									>
										{received ? "+" : "−"}
										{tx.amount} {tx.currency}
									</span>
								</button>
							);
						})}
					</div>
				)}
			</div>

			{/* Receipt modal */}
			{selectedTx && (
				<div
					className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center px-5 gap-4 animate-fade-in"
					onClick={() => setSelectedTx(null)}
				>
					<div
						ref={txCardRef}
						className="relative overflow-hidden w-full max-w-sm bg-surface border border-border rounded-[24px] p-8 flex flex-col items-center shadow-e3"
						onClick={(e) => e.stopPropagation()}
					>
						<div
							className="absolute top-0 left-0 right-0 h-1"
							style={{ background: "linear-gradient(100deg,#9ce3f4,#f4a9cf 52%,#efe08c)" }}
						/>
						<div
							className="pointer-events-none absolute -top-20 -left-16 w-48 h-48 rounded-full opacity-[0.14] blur-2xl"
							style={{
								background:
									selectedTx.type === "received"
										? "radial-gradient(circle,#9ce3f4,transparent 70%)"
										: "radial-gradient(circle,#f4a9cf,transparent 70%)",
							}}
						/>

						<div className="flex items-center gap-2 mb-6 relative z-1">
							<Logo className="w-6" />
							<span className="font-display text-[16px]">Parmelia</span>
						</div>
						<div
							className="w-14 h-14 rounded-full flex items-center justify-center mb-5 relative z-1"
							style={{
								background: selectedTx.type === "received" ? "rgba(156,227,244,0.16)" : "rgba(245,245,243,0.08)",
							}}
						>
							<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={selectedTx.type === "received" ? "#9ce3f4" : "#f5f5f3"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
								<polyline points="20 6 9 17 4 12" />
							</svg>
						</div>
						<p className="text-[14px] text-text-muted mb-1 relative z-1">
							{selectedTx.type === "sent" ? "Pagaste" : "Recibiste"}
						</p>
						<p className="font-display text-[40px] leading-none mb-4 tabular relative z-1">
							{selectedTx.type === "sent" ? "−" : "+"}
							{selectedTx.amount}
							<span className="text-text-muted text-[20px] ml-1.5">{selectedTx.currency}</span>
						</p>
						{selectedTx.to && (
							<p className="text-text-faint text-[12px] font-mono break-all text-center mb-1 relative z-1">
								Para {selectedTx.to.slice(0, 6)}…{selectedTx.to.slice(-4)}
							</p>
						)}
						{selectedTx.reference && (
							<p className="text-text-muted text-[14px] text-center mb-1 relative z-1">{selectedTx.reference}</p>
						)}
						<p className="text-[12px] text-text-faint mt-2 relative z-1">parmelia.me</p>
						{selectedTx.txHash && (
							<a
								href={getExplorerTxUrl(selectedTx.txHash)}
								target="_blank"
								rel="noopener noreferrer"
								className="text-text-faint text-[12px] mt-2 relative z-1"
							>
								Ver comprobante en la red ↗
							</a>
						)}
					</div>

					<div className="flex gap-3 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
						<button
							onClick={async () => {
								if (!txCardRef.current) return;
								try {
									const { toPng } = await import("html-to-image");
										const dataUrl = await toPng(txCardRef.current, {
										backgroundColor: "#0A0A0B",
										width: txCardRef.current.offsetWidth + 64,
										height: txCardRef.current.offsetHeight + 64,
										style: { flex: "none", padding: "32px", margin: "0", maxWidth: "none" },
										pixelRatio: 2,
									});
									const a = document.createElement("a");
									a.download = `parmelia-${selectedTx.amount}-${selectedTx.currency}.png`;
									a.href = dataUrl;
									a.click();
								} catch {
									/* ignore */
								}
							}}
							className="btn btn-primary flex-1"
						>
							Descargar comprobante
						</button>
						<button onClick={() => setSelectedTx(null)} className="btn btn-ghost">
							Cerrar
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

function IconReceive({ small }: { small?: boolean }) {
	const s = small ? 18 : 22;
	return (
		<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M12 5v14" />
			<path d="m19 12-7 7-7-7" />
		</svg>
	);
}

function IconSend({ small }: { small?: boolean }) {
	const s = small ? 18 : 22;
	return (
		<svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M12 19V5" />
			<path d="m5 12 7-7 7 7" />
		</svg>
	);
}

function IconScan() {
	return (
		<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M3 7V5a2 2 0 0 1 2-2h2" />
			<path d="M17 3h2a2 2 0 0 1 2 2v2" />
			<path d="M21 17v2a2 2 0 0 1-2 2h-2" />
			<path d="M7 21H5a2 2 0 0 1-2-2v-2" />
			<path d="M3 12h18" />
		</svg>
	);
}

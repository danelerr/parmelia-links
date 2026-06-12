import { type User } from "../lib/firebase";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { SERVER_URL } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import Logo from "../components/Logo";
import ReceiptModal from "../components/ReceiptModal";
import { activeNetwork } from "../lib/activeNetwork";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { parseTransactions, formatShortDate, txLabel, type Transaction } from "../lib/transactions";

const RECENT_COUNT = 5;

function formatBalance(symbol: string, value: string | undefined) {
	const n = Number(value ?? "0");
	if (!Number.isFinite(n)) return value ?? "0";
	if (symbol === "USDC") {
		return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	}
	return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

export default function Home({ user }: { user: User }) {
	const navigate = useViewTransitionNavigate();
	const [copied, setCopied] = useState(false);
	const currencies = activeNetwork.currencies;
	const [selectedCurrency, setSelectedCurrency] = useState(currencies[0] ?? "USDC");
	const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);

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

	// Derived from polled data — memoized so maps + sort don't re-run per render.
	const transactions: Transaction[] = useMemo(() => parseTransactions(txData), [txData]);
	const recent = transactions.slice(0, RECENT_COUNT);

	const walletAddress = profile?.walletAddress || null;
	const username = profile?.username || null;
	const balances: Record<string, string> = balance?.tokens || {
		ETH: balance?.eth,
		USDC: balance?.usdc,
	};

	function handleCopyAddress() {
		if (!walletAddress) return;
		navigator.clipboard.writeText(walletAddress);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}

	const quickActions = [
		{ label: "Cobrar", to: "/charge", accent: "#f4a9cf", icon: <IconReceive /> },
		{ label: "Pagar", to: "/send", accent: "#9ce3f4", icon: <IconSend /> },
		{ label: "Cambiar", to: "/swap", accent: "#efe08c", icon: <IconSwap /> },
		{ label: "Escanear", to: "/scan", accent: "#f5f5f3", icon: <IconScan /> },
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

				{/* Currency segmented control (whitelisted assets on this chain) */}
				<div className="flex justify-center mb-5 relative z-1">
					<div className="seg-track">
						{currencies.map((c) => (
							<button
								key={c}
								onClick={() => setSelectedCurrency(c)}
								data-active={selectedCurrency === c}
								className="seg-item"
							>
								{c}
							</button>
						))}
					</div>
				</div>

				<div className="flex flex-col items-center mb-5 relative z-1">
					<p className="text-[13px] text-text-muted mb-1">Tu saldo</p>
					<p className="font-display text-[46px] leading-none tabular">
						{selectedCurrency === "USDC" && (
							<span className="text-text-muted text-[28px] align-top mr-0.5">$</span>
						)}
						{formatBalance(selectedCurrency, balances[selectedCurrency])}
						{selectedCurrency !== "USDC" && (
							<span className="text-text-muted text-[20px] ml-2">{selectedCurrency}</span>
						)}
					</p>
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
				<button
					onClick={() => navigate("/deposit")}
					className="mx-auto mt-1 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] text-text-faint hover:text-text-muted transition-colors relative z-1"
				>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="12" cy="12" r="9" />
						<path d="M12 7v10M7 12h10" />
					</svg>
					Recibir desde otra red
				</button>
			</div>

			{/* Quick actions */}
			<div className="grid grid-cols-4 gap-2.5 mb-7">
				{quickActions.map((a) => (
					<button
						key={a.label}
						onClick={() => navigate(a.to)}
						className="flex flex-col items-center gap-2.5 py-4 bg-surface border border-border rounded-[18px] hover:border-border-strong hover:-translate-y-0.5 transition-all duration-200"
					>
						<span
							className="w-10 h-10 rounded-full flex items-center justify-center"
							style={{ background: `${a.accent}26`, color: a.accent }}
						>
							{a.icon}
						</span>
						<span className="text-[13px] font-medium">{a.label}</span>
					</button>
				))}
			</div>

			{/* Recent activity — compact; the full statement lives in /extractos */}
			<div className="flex items-center justify-between mb-3 px-1">
				<h2 className="font-display text-[18px]">Actividad reciente</h2>
				{isTxLoading && txData && <span className="w-2 h-2 rounded-full bg-sky animate-pulse" />}
			</div>

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
					<button onClick={() => navigate("/charge")} className="btn btn-primary btn-sm">
						Crear un link de cobro
					</button>
				</div>
			) : (
				<>
					<div className="flex flex-col gap-1">
						{recent.map((tx) => {
							const received = tx.type === "received";
							return (
								<button
									key={tx.txHash + tx.type}
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
										<p className="text-[15px] truncate">{txLabel(tx)}</p>
										<p className="text-[12px] text-text-faint">{formatShortDate(tx.createdAt)}</p>
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
					<button onClick={() => navigate("/statement")} className="btn-text w-full mt-3">
						Ver extracto completo
					</button>
				</>
			)}

			{selectedTx && <ReceiptModal tx={selectedTx} onClose={() => setSelectedTx(null)} />}
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

function IconSwap() {
	return (
		<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M7 4v16" />
			<path d="m3 8 4-4 4 4" />
			<path d="M17 20V4" />
			<path d="m13 16 4 4 4-4" />
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

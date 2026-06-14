import { type User } from "../lib/firebase";
import { useMemo, useState } from "react";
import useSWR from "swr";
import { SERVER_URL } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import Logo from "../components/Logo";
import ReceiptModal from "../components/ReceiptModal";
import { Skeleton, RowSkeletonList } from "../components/Skeleton";
import { activeNetwork } from "../lib/activeNetwork";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { useTranslation } from "react-i18next";
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
	const { t } = useTranslation();
	const [copied, setCopied] = useState(false);
	// Privacy toggle - persisted so the balance stays hidden across sessions.
	const [hideBalance, setHideBalance] = useState(
		() => localStorage.getItem("parmelia:hideBalance") === "1",
	);
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

	// Derived from polled data - memoized so maps + sort don't re-run per render.
	const transactions: Transaction[] = useMemo(() => parseTransactions(txData), [txData]);
	const recent = transactions.slice(0, RECENT_COUNT);

	const balanceLoading = isBalanceLoading && !balance;

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

	function toggleHideBalance() {
		setHideBalance((prev) => {
			const next = !prev;
			try {
				localStorage.setItem("parmelia:hideBalance", next ? "1" : "0");
			} catch {
				/* storage unavailable - toggle still works for the session */
			}
			return next;
		});
	}

	// The two core, symmetric actions. Scan lives in the top bar (it's a way to
	// pay, not a peer action) and Cambiar is a lower-frequency secondary below.
	const primaryActions = [
		{ label: t("common.charge"), to: "/charge", accent: "#f4a9cf", icon: <IconReceive /> },
		{ label: t("common.pay"), to: "/send", accent: "#9ce3f4", icon: <IconSend /> },
	];

	return (
		<div className="flex flex-col min-h-dvh px-5 pt-[calc(env(safe-area-inset-top)_+_1.5rem)] pb-[calc(env(safe-area-inset-bottom)_+_3rem)] w-full max-w-[460px] mx-auto animate-fade-up">
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
				<div className="flex items-center gap-2">
					<button
						onClick={() => navigate("/scan")}
						aria-label={t("home.scanAria")}
						className="w-11 h-11 rounded-full bg-sky/15 text-glow-sky flex items-center justify-center hover:bg-sky/25 active:scale-95 transition-all"
					>
						<IconScan size={22} />
					</button>
					<button
						onClick={() => navigate("/settings")}
						aria-label={t("common.settings")}
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
				</div>
			</header>

			{/* Balance card */}
			<div className="relative overflow-hidden bg-surface border border-border rounded-[22px] p-6 mb-4 shadow-e2">
				<div
					className="pointer-events-none absolute -top-16 -right-10 w-48 h-48 rounded-full opacity-[0.18] blur-2xl"
					style={{ background: "radial-gradient(circle, #9ce3f4, transparent 70%)" }}
				/>

				{/* Hide-balance toggle (privacy) */}
				<button
					onClick={toggleHideBalance}
					aria-label={hideBalance ? t("home.showBalance") : t("home.hideBalance")}
					aria-pressed={hideBalance}
					className="absolute top-2.5 right-2.5 z-10 w-11 h-11 rounded-full flex items-center justify-center text-text-faint hover:text-text-muted hover:bg-surface-2 active:scale-95 transition-all"
				>
					{hideBalance ? <IconEyeOff /> : <IconEye />}
				</button>

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
					<p className="text-[13px] text-text-muted mb-1">{t("home.balance")}</p>
					{balanceLoading ? (
						<Skeleton className="h-[46px] w-44 rounded-[14px] my-0.5" />
					) : (
						<p className="font-display text-[46px] leading-none tabular select-none">
							{selectedCurrency === "USDC" && (
								<span className="text-text-muted text-[28px] align-top mr-0.5">$</span>
							)}
							{hideBalance ? "••••" : formatBalance(selectedCurrency, balances[selectedCurrency])}
							{selectedCurrency !== "USDC" && (
								<span className="text-text-muted text-[20px] ml-2">{selectedCurrency}</span>
							)}
						</p>
					)}
				</div>

				<button
					onClick={handleCopyAddress}
					className="mx-auto flex items-center gap-2 px-3.5 py-2 rounded-full text-[12px] text-text-faint hover:text-text-muted hover:bg-surface-2 transition-colors relative z-1"
				>
					<span className="font-mono">
						{walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : t("common.loading")}
					</span>
					<span>{copied ? t("common.copied") : t("common.copy")}</span>
				</button>
				<button
					onClick={() => navigate("/deposit")}
					className="mx-auto mt-1 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[12px] text-text-faint hover:text-text-muted transition-colors relative z-1"
				>
					<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="12" cy="12" r="9" />
						<path d="M12 7v10M7 12h10" />
					</svg>
					{t("home.receiveOtherNetwork")}
				</button>
			</div>

			{/* Primary actions - Cobrar / Pagar */}
			<div className="grid grid-cols-2 gap-3 mb-3">
				{primaryActions.map((a) => (
					<button
						key={a.label}
						onClick={() => navigate(a.to)}
						className="flex items-center justify-center gap-2.5 py-4 bg-surface border border-border rounded-[18px] hover:border-border-strong hover:-translate-y-0.5 transition-all duration-200"
					>
						<span
							className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
							style={{ background: `${a.accent}26`, color: a.accent }}
						>
							{a.icon}
						</span>
						<span className="text-[15px] font-medium">{a.label}</span>
					</button>
				))}
			</div>

			{/* Secondary action - Cambiar (lower frequency) */}
			<button
				onClick={() => navigate("/swap")}
				className="flex items-center justify-center gap-2 mx-auto mb-7 px-4 py-2 rounded-full text-[13px] text-text-muted hover:text-text hover:bg-surface transition-colors"
			>
				<IconSwap size={16} />
				{t("common.swap")}
			</button>

			{/* Recent activity - compact; the full statement lives in /extractos */}
			<div className="flex items-center justify-between mb-3 px-1">
				<h2 className="font-display text-[18px]">{t("home.recentActivity")}</h2>
				{isTxLoading && txData && <span className="w-2 h-2 rounded-full bg-sky animate-pulse" />}
			</div>

			{isTxLoading && !txData ? (
				<RowSkeletonList count={RECENT_COUNT} />
			) : transactions.length === 0 ? (
				<div className="flex flex-col items-center text-center py-14 px-6">
					<Logo className="w-12 mb-5 opacity-40" />
					<p className="text-[15px] text-text mb-1">{t("home.noActivity")}</p>
					<p className="text-[13px] text-text-muted mb-6 max-w-[240px] leading-relaxed">
						{t("home.noActivityBody")}
					</p>
					<button onClick={() => navigate("/charge")} className="btn btn-primary btn-sm">
						{t("home.createFirstLink")}
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
											received ? "bg-sky/15 text-glow-sky" : "bg-pink/15 text-glow-pink"
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
											hideBalance ? "text-text-faint" : received ? "text-glow-sky" : "text-glow-pink"
										}`}
									>
										{!hideBalance && (received ? "+" : "−")}
										{hideBalance ? "••••" : `${tx.amount} ${tx.currency}`}
									</span>
								</button>
							);
						})}
					</div>
					<button onClick={() => navigate("/statement")} className="btn-text w-full mt-3">
						{t("home.viewFullStatement")}
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

function IconSwap({ size = 20 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M7 4v16" />
			<path d="m3 8 4-4 4 4" />
			<path d="M17 20V4" />
			<path d="m13 16 4 4 4-4" />
		</svg>
	);
}

function IconEye() {
	return (
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
			<circle cx="12" cy="12" r="3" />
		</svg>
	);
}

function IconEyeOff() {
	return (
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a16.9 16.9 0 0 1-3.3 4.1" />
			<path d="M6.6 6.6A16.8 16.8 0 0 0 2 12s3.5 7 10 7a10.3 10.3 0 0 0 5.4-1.6" />
			<path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
			<path d="m3 3 18 18" />
		</svg>
	);
}

function IconScan({ size = 22 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M3 7V5a2 2 0 0 1 2-2h2" />
			<path d="M17 3h2a2 2 0 0 1 2 2v2" />
			<path d="M21 17v2a2 2 0 0 1-2 2h-2" />
			<path d="M7 21H5a2 2 0 0 1-2-2v-2" />
			<path d="M3 12h18" />
		</svg>
	);
}

import { type User } from "../lib/firebase";
import { useMemo, useState } from "react";
import { notifySuccess } from "../lib/notify";
import Logo from "../components/Logo";
import LinkButton from "../components/LinkButton";
import ReceiptModal from "../components/ReceiptModal";
import { Skeleton, RowSkeletonList } from "../components/Skeleton";
import { activeNetwork } from "../lib/activeNetwork";
import { useTranslation } from "react-i18next";
import { parseTransactions, formatShortDate, txLabel, type Transaction } from "../lib/transactions";
import { formatAmount, formatNumber } from "../lib/format";
import MenuSheet from "../components/MenuSheet";
import { useHomeModel } from "../hooks/useHomeModel";

const RECENT_COUNT = 5;

export default function Home({ user }: { user: User }) {
	const { t } = useTranslation();
	const [copied, setCopied] = useState(false);
	// Privacy toggle - persisted so the balance stays hidden across sessions.
	const [hideBalance, setHideBalance] = useState(
		() => localStorage.getItem("parmelia:hideBalance") === "1",
	);
	const currencies = activeNetwork.currencies;
	const [selectedCurrency, setSelectedCurrency] = useState(currencies[0] ?? "USDC");
	const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);

	const {
		data: home,
		isLoading,
		isValidating,
		fromLocalCache,
	} = useHomeModel(user);
	const balance = home?.balance;
	const txData = home?.activity;

	const transactions: Transaction[] = useMemo(
		() => parseTransactions(txData),
		[txData],
	);
	const recent = transactions.slice(0, RECENT_COUNT);

	const balanceLoading = isLoading && !balance;

	const walletAddress = home?.account.walletAddress || null;
	const username = home?.identity.username || null;
	const balances: Record<string, string> = balance?.tokens || {};

	function handleCopyAddress() {
		if (!walletAddress) return;
		navigator.clipboard.writeText(walletAddress);
		// Subtle haptic tick on supported devices.
		if ("vibrate" in navigator) navigator.vibrate(15);
		setCopied(true);
		setTimeout(() => setCopied(false), 2000);
	}

	// Empty-state nudge: share your wallet address so others can pay you to it.
	// Native share sheet when available; otherwise copy with a toast.
	async function handleShareAddress() {
		if (!walletAddress) return;
		const text = t("home.shareAddressText", { address: walletAddress });
		if (navigator.share) {
			try {
				await navigator.share({ title: "Parmelia", text });
				return;
			} catch {
				/* user dismissed the share sheet */
			}
		}
		navigator.clipboard.writeText(walletAddress);
		notifySuccess(t("settings.addressCopied"));
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
		<div className="flex flex-col min-h-dvh px-5 pt-[calc(env(safe-area-inset-top)+1.5rem)] pb-[calc(env(safe-area-inset-bottom)+3rem)] w-full max-w-115 mx-auto animate-fade-up">
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
					<LinkButton
						to="/scan"
						aria-label={t("home.scanAria")}
						className="w-11 h-11 rounded-full bg-sky/15 text-glow-sky flex items-center justify-center hover:bg-sky/25 active:scale-95 transition"
					>
						<IconScan size={22} />
					</LinkButton>
					<button
						onClick={() => setMenuOpen(true)}
						aria-label={t("menu.aria")}
						aria-haspopup="dialog"
						className="relative shrink-0 active:scale-95 transition"
					>
						<span className="w-10 h-10 rounded-full overflow-hidden border border-border flex items-center justify-center bg-surface hover:border-border-strong transition-colors">
							{user.photoURL ? (
								<img src={user.photoURL} alt="" width="48" height="48" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
							) : (
								<span className="text-sm font-display text-sky uppercase">
									{(username || user.displayName || "?")[0]}
								</span>
							)}
						</span>
						{/* Affordance badge: the photo is a button, not decoration. */}
						<span className="absolute -bottom-0.5 -right-0.5 w-4.5 h-4.5 rounded-full bg-surface-2 border border-border flex items-center justify-center text-text-muted">
							<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
								<path d="m6 9 6 6 6-6" />
							</svg>
						</span>
					</button>
				</div>
			</header>

			{/* Balance card */}
			<div className="relative overflow-hidden bg-surface border border-border rounded-lg p-6 mb-4 shadow-e2">
				<div
					className="pointer-events-none absolute -top-16 -right-10 w-48 h-48 rounded-full opacity-[0.18] blur-2xl"
					style={{ background: "radial-gradient(circle, #9ce3f4, transparent 70%)" }}
				/>

				{/* Hide-balance toggle (privacy) */}
				<button
					onClick={toggleHideBalance}
					aria-label={hideBalance ? t("home.showBalance") : t("home.hideBalance")}
					aria-pressed={hideBalance}
					className="absolute top-2.5 right-2.5 z-10 w-11 h-11 rounded-full flex items-center justify-center text-text-faint hover:text-text-muted hover:bg-surface-2 active:scale-95 transition"
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
								aria-pressed={selectedCurrency === c}
								data-active={selectedCurrency === c}
								className="seg-item"
							>
								{c}
							</button>
						))}
					</div>
				</div>

				<div className="flex flex-col items-center mb-5 relative z-1">
					<p className="text-[13px] text-text-muted mb-1">
						{selectedCurrency === "USDC" ? t("home.digitalDollars") : t("home.balance")}
					</p>
					{balanceLoading ? (
						<Skeleton className="h-11.5 w-44 rounded-[14px] my-0.5" />
					) : balances[selectedCurrency] === undefined ? (
						<p
							className="font-display text-[46px] leading-none text-text-faint"
							aria-label={t("home.balanceUnavailable")}
						>
							—
						</p>
					) : (
						<p className="font-display text-[46px] leading-none tabular select-none">
							{selectedCurrency === "USDC" && (
								<span className="text-text-muted text-[28px] align-top mr-0.5">$</span>
							)}
							{hideBalance ? "••••" : formatAmount(balances[selectedCurrency], selectedCurrency)}
							{selectedCurrency !== "USDC" && (
								<span className="text-text-muted text-[20px] ml-2">{selectedCurrency}</span>
							)}
						</p>
					)}
					{/* Savings pocket (Earn): kept apart from the payable balance on
					    purpose - tap-through to move money in or out. */}
					{typeof balance?.savings === "string" && Number(balance.savings) > 0 && (
						<LinkButton
							to="/earn"
							className="mt-2.5 px-3.5 py-1.5 rounded-full bg-surface-2 text-[12px] text-text-muted hover:text-text active:scale-95 transition"
						>
							{t("home.inSavings", {
								amount: hideBalance ? "••••" : formatNumber(balance.savings, 2),
							})}
						</LinkButton>
					)}
				</div>

				<div className="flex flex-col items-center gap-1 relative z-1">
					{balance?.observedAt && (
						<span className="text-[10px] text-text-faint">
							{balance.status === "fresh" && !fromLocalCache
								? t("home.dataFresh")
								: t("home.dataCached")}
							{isValidating ? " · …" : ""}
						</span>
					)}
					<span className="text-[10px] uppercase tracking-widest text-text-faint">
						{t("home.yourAddress")}
					</span>
					<button
						onClick={handleCopyAddress}
						disabled={!walletAddress}
						aria-label={copied ? t("common.copied") : t("common.copy")}
						className="flex items-center gap-2 px-3.5 py-1.5 rounded-full text-[13px] text-text-muted hover:text-text hover:bg-surface-2 active:scale-95 transition"
					>
						<span className="font-mono">
							{walletAddress ? `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}` : t("common.loading")}
						</span>
						<span className={copied ? "text-glow-sky" : "text-text-faint"}>
							{copied ? <IconCheck /> : <IconCopy />}
						</span>
					</button>
				</div>
			</div>

			{/* Primary actions - Cobrar / Pagar */}
			<div className="grid grid-cols-2 gap-3 mb-3">
				{primaryActions.map((a) => (
					<LinkButton
						key={a.label}
						to={a.to}
						className="flex items-center justify-center gap-2.5 py-4 bg-surface border border-border rounded-[18px] hover:border-border-strong hover:-translate-y-0.5 transition duration-200"
					>
						<span
							className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
							style={{ background: `${a.accent}26`, color: a.accent }}
						>
							{a.icon}
						</span>
						<span className="text-[15px] font-medium">{a.label}</span>
					</LinkButton>
				))}
			</div>

			{/* Secondary utilities - Depositar / Cambiar / Ahorro (lower frequency).
			    UX_DESIGN.md R-1: this row caps at 4 tiles (the 4th is the future
			    card); anything else lives inside a hub, never here. */}
			<div className="grid grid-cols-3 gap-2.5 mb-7">
				{[
					{
						label: t("home.deposit"),
						to: "/receive",
						icon: (
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M12 3v12" />
								<path d="m7 10 5 5 5-5" />
								<path d="M5 21h14" />
							</svg>
						),
					},
					{ label: t("common.swap"), to: "/swap", icon: <IconSwap size={18} /> },
					{
						label: t("home.earn"),
						to: "/earn",
						icon: (
							<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M3 17l6-6 4 4 7-7" />
								<path d="M17 7h4v4" />
							</svg>
						),
					},
				].map((a) => (
					<LinkButton
						key={a.label}
						to={a.to}
						className="flex flex-col items-center justify-center gap-1.5 py-3.5 bg-surface border border-border rounded-[16px] text-text-muted hover:text-text hover:border-border-strong transition-colors"
					>
						{a.icon}
						<span className="text-[12px] font-medium">{a.label}</span>
					</LinkButton>
				))}
			</div>

			{/* Recent activity - compact; the full statement lives in /extractos */}
			<div className="flex items-center justify-between mb-3 px-1">
				<h2 className="font-display text-[18px]">{t("home.recentActivity")}</h2>
				{isValidating && txData && <span className="w-2 h-2 rounded-full bg-sky animate-pulse" />}
			</div>

			{isLoading && !txData ? (
				<RowSkeletonList count={RECENT_COUNT} />
			) : transactions.length === 0 ? (
				<div className="flex flex-col items-center text-center py-14 px-6">
					<Logo className="w-12 mb-5 opacity-40" />
					<p className="text-[15px] text-text mb-1">{t("home.noActivity")}</p>
					<p className="text-[13px] text-text-muted mb-6 max-w-60 leading-relaxed">
						{t("home.noActivityBody")}
					</p>
					<LinkButton to="/charge" className="btn btn-primary btn-sm">
						{t("home.createFirstLink")}
					</LinkButton>
					{walletAddress && (
						<button onClick={handleShareAddress} className="btn-text mt-2 text-[13px]">
							{t("home.shareAddressNudge")}
						</button>
					)}
				</div>
			) : (
				<>
					<div className="flex flex-col gap-1">
						{recent.map((tx) => {
							const received = tx.type === "received";
							return (
								<button
									key={tx.id}
									onClick={() => setSelectedTx(tx)}
									className="flex items-center gap-3.5 py-3 px-2 -mx-2 rounded-[14px] hover:bg-surface transition-colors text-left"
								>
									<span
										className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${received ? "bg-sky/15 text-glow-sky" : "bg-pink/15 text-glow-pink"
											}`}
									>
										{received ? <IconReceive small /> : <IconSend small />}
									</span>
									<div className="min-w-0 flex-1">
										<p className="text-[15px] truncate">{txLabel(tx)}</p>
										<p className="text-[12px] text-text-faint">{formatShortDate(tx.createdAt)}</p>
									</div>
									<span
										className={`text-[15px] font-medium tabular shrink-0 ${hideBalance ? "text-text-faint" : received ? "text-glow-sky" : "text-glow-pink"
											}`}
									>
										{!hideBalance && (received ? "+" : "−")}
										{hideBalance ? "••••" : `${formatAmount(tx.amount, tx.currency)} ${tx.currency}`}
									</span>
								</button>
							);
						})}
					</div>
					<LinkButton to="/statement" className="btn-text w-full mt-3">
						{t("home.viewFullStatement")}
					</LinkButton>
				</>
			)}

			{selectedTx && <ReceiptModal tx={selectedTx} onClose={() => setSelectedTx(null)} />}
			{menuOpen && <MenuSheet user={user} username={username} onClose={() => setMenuOpen(false)} />}
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

function IconCopy() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<rect x="9" y="9" width="13" height="13" rx="2" />
			<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
		</svg>
	);
}

function IconCheck() {
	return (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
			<polyline points="20 6 9 17 4 12" />
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

import { lazy, Suspense, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { User } from "../lib/firebase";
import { activeNetwork } from "../lib/activeNetwork";
import { formatAmount, formatNumber } from "../lib/format";
import { parseTransactions, type Transaction } from "../lib/transactions";
import { notifyError, notifySuccess } from "../lib/notify";
import type { HomeReadModel } from "../lib/homeData";
import { useHomeModel } from "../hooks/useHomeModel";
import { useDialog } from "../hooks/useDialog";
import Logo from "../components/Logo";
import LinkButton from "../components/LinkButton";
import MenuSheet from "../components/MenuSheet";
import ReceiptModal from "../components/ReceiptModal";
import PrimaryNav from "../components/PrimaryNav";
import PwaInstallButton from "../components/PwaInstallButton";
import ActivityRow from "../components/ActivityRow";
import TokenSelect from "../components/TokenSelect";
import { RowSkeletonList, Skeleton } from "../components/Skeleton";
import MeliSprite from "../components/brand/MeliSprite";
import { readMigratedStorage, writeStorage } from "../lib/storageMigration";
import { useChainPortfolio, type ChainPortfolio, type ChainPortfolioItem } from "../hooks/useChainPortfolio";

const CardInterestSheet = lazy(() => import("../components/CardInterestSheet"));
const RECENT_COUNT = 4;
const HIDE_BALANCE_KEY = "gatopago:hideBalance";
const LEGACY_HIDE_BALANCE_KEY = "parmelia:hideBalance";

export default function Home({ user, previewModel, previewPortfolio }: { user: User; previewModel?: HomeReadModel; previewPortfolio?: ChainPortfolio }) {
	const { t } = useTranslation();
	const [hideBalance, setHideBalance] = useState(() => {
		try {
			return readMigratedStorage(HIDE_BALANCE_KEY, LEGACY_HIDE_BALANCE_KEY) === "1";
		} catch {
			return false;
		}
	});
	const [selectedAssetKey, setSelectedAssetKey] = useState(`${activeNetwork.chainId}:USDC`);
	const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [detailsOpen, setDetailsOpen] = useState(false);
	const [cardInterestOpen, setCardInterestOpen] = useState(false);
	const [cardInterestSaved, setCardInterestSaved] = useState(false);
	const {
		data: home,
		isLoading,
		isValidating,
		fromLocalCache,
		isRefreshingBalance,
		refreshBalance,
	} = useHomeModel(user, previewModel);
	const {
		data: chainPortfolio,
		isValidating: isPortfolioValidating,
		mutate: mutatePortfolio,
		isRefreshingChain,
		refreshChainBalance,
	} = useChainPortfolio(user, previewPortfolio);

	const transactions = useMemo(() => parseTransactions(home?.activity), [home?.activity]);
	const assetLocations = useMemo(() => {
		const active = chainPortfolio?.chains.flatMap((chain) =>
			chain.account?.status === "active"
				? chain.balance.assets.map((asset) => ({ chain, asset, key: `${chain.chainId}:${asset.symbol}` }))
				: [],
		) ?? [];
		if (active.length > 0) return active;
		return activeNetwork.currencies.map((symbol) => ({
			chain: {
				key: activeNetwork.key,
				chainId: activeNetwork.chainId,
				name: activeNetwork.name,
				nativeTokenSymbol: activeNetwork.nativeTokenSymbol,
				isTestnet: activeNetwork.isTestnet,
				walletRailEnabled: true,
				swapEnabled: true,
				explorerBaseUrl: activeNetwork.explorerBaseUrl,
				faucetUrl: activeNetwork.faucetUrl,
				rpcConfigured: true,
				account: home?.account.walletAddress ? { walletAddress: home.account.walletAddress, status: "active" as const, securityStatus: "current" as const, securityVersionApplied: 1, securityVersionDesired: 1 } : null,
				balance: { assets: [] },
			},
			asset: { symbol, name: symbol, decimals: symbol === "USDC" ? 6 : 18, isNative: symbol === activeNetwork.nativeTokenSymbol, value: home?.balance.tokens[symbol] ?? null, raw: null, status: home?.balance.status ?? "unavailable" as const, observedAt: home?.balance.observedAt ?? null, blockNumber: null, blockHash: null },
			key: `${activeNetwork.chainId}:${symbol}`,
		}));
	}, [chainPortfolio, home]);
	const assetOptions = useMemo(() => assetLocations.map((location) => location.key), [assetLocations]);
	const portfolioBalances = useMemo(() => Object.fromEntries(assetLocations.flatMap((location) => location.asset.value === null ? [] : [[location.key, location.asset.value]])), [assetLocations]);
	const assetOptionDetails = useMemo(() => Object.fromEntries(assetLocations.map((location) => [location.key, {
		symbol: location.asset.symbol,
		label: location.asset.symbol,
		description: `${location.asset.name} · ${location.chain.name}`,
	}])), [assetLocations]);
	const effectiveAssetKey = assetOptions.includes(selectedAssetKey)
		? selectedAssetKey
		: assetOptions[0] ?? selectedAssetKey;
	const selectedLocation = assetLocations.find((location) => location.key === effectiveAssetKey) ?? assetLocations[0];
	const selectedToken = selectedLocation?.asset.symbol ?? "USDC";
	const selectedChain = selectedLocation?.chain;
	const selectedChainSecurityCurrent = selectedChain?.account?.securityStatus === "current" &&
		selectedChain.account.securityVersionApplied === selectedChain.account.securityVersionDesired;
	const selectedChainOperational = selectedChain?.account?.status === "active" &&
		selectedChain.walletRailEnabled && selectedChain.rpcConfigured;
	const selectedChainExecutionReady = selectedChainOperational && selectedChainSecurityCurrent;
	const available = selectedLocation?.asset.value ?? undefined;
	const selectedObservedAt = selectedLocation?.asset.observedAt ?? null;
	const selectedBalanceStatus = selectedLocation?.asset.status ?? "unavailable";
	const selectedBalanceRefreshing = selectedChain?.key === activeNetwork.key
		? isRefreshingBalance
		: Boolean(selectedChain?.key && isRefreshingChain(selectedChain.key));
	const growing = home?.balance.savings;
	const username = home?.identity.username ?? null;
	const walletAddress = home?.account.walletAddress ?? null;

	function toggleHideBalance() {
		setHideBalance((current) => {
			const next = !current;
			writeStorage(HIDE_BALANCE_KEY, next ? "1" : "0");
			return next;
		});
	}

	async function handleBalanceRefresh() {
		try {
			if (selectedChain?.key === activeNetwork.key) {
				await refreshBalance();
				await mutatePortfolio();
			} else if (selectedChain?.key) {
				await refreshChainBalance(selectedChain.key);
			}
		} catch (error) {
			notifyError(error, t("home.refreshBalanceError"));
		}
	}

	return (
		<main id="main-content" className="app-frame relative mx-auto flex min-h-dvh w-full max-w-[480px] flex-col px-5 pt-[calc(env(safe-area-inset-top)+1.5rem)] pb-[calc(env(safe-area-inset-bottom)+7.75rem)] animate-fade-up">
			<header className="meli-app-header mb-6">
				<button type="button" onClick={() => setDetailsOpen(true)} aria-haspopup="dialog" className="meli-identity interactive-surface">
					<span className="meli-avatar"><Logo className="w-8" /></span>
					<span className="min-w-0 leading-tight">
						<strong className="block truncate font-display text-[15px]">{username ? `@${username}` : "GatoPago"}</strong>
						<small className="mt-1 flex items-center gap-1.5 truncate whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.08em] text-text-faint">
							{t("home.personalAccount")}
							{activeNetwork.isTestnet ? <span aria-hidden="true" className="hidden min-[390px]:inline">· Alpha</span> : null}
						</small>
					</span>
					<ChevronDown />
				</button>
				<div className="flex items-center gap-2">
					<PwaInstallButton />
					<button type="button" onClick={() => setMenuOpen(true)} aria-label={t("menu.aria")} aria-haspopup="dialog" className="meli-avatar">
						{user.photoURL ? <img src={user.photoURL} alt="" width="44" height="44" className="h-full w-full object-cover" referrerPolicy="no-referrer" /> : <span className="font-display text-[14px] font-bold uppercase">{(username || user.displayName || "?")[0]}</span>}
					</button>
				</div>
			</header>

			{home?.security.hasRegisteredPasskey === false ? (
				<LinkButton
					to="/settings/security"
					className="meli-paper-card interactive-surface mb-5 border-l-4 border-l-pending p-4 text-left"
				>
					<span className="block font-display text-[16px] text-pending">
						{t("passkeyGuidance.noneTitle")}
					</span>
					<span className="mt-1 block text-[12px] leading-relaxed text-text-muted">
						{t("passkeyGuidance.noneBody")}
					</span>
					<span className="mt-3 inline-block font-mono text-[10px] font-bold uppercase tracking-[0.06em] text-pending">
						{t("passkeyGuidance.noneCta")} →
					</span>
				</LinkButton>
			) : null}

			<section aria-labelledby="available-heading" className="meli-balance-card-app p-5">
				<div className="mb-3 flex items-center justify-between gap-3">
					<h1 id="available-heading" className="font-mono text-[10px] uppercase tracking-[0.12em] text-text-muted">{t("home.available")}</h1>
					<div className="flex shrink-0 items-center gap-1">
						<TokenSelect value={effectiveAssetKey} options={assetOptions} balances={portfolioBalances} optionDetails={assetOptionDetails} hideBalances={hideBalance} onChange={setSelectedAssetKey} />
						<button type="button" onClick={toggleHideBalance} aria-label={hideBalance ? t("home.showBalance") : t("home.hideBalance")} aria-pressed={hideBalance} className="flex h-10 w-10 shrink-0 items-center justify-center text-text-faint">{hideBalance ? <EyeOffIcon /> : <EyeIcon />}</button>
					</div>
				</div>
				{isLoading && available === undefined ? <Skeleton className="h-11 w-44" /> : available === undefined ? <p className="font-display text-[42px] text-text-faint">—</p> : (
					<p className="type-mono text-[42px] font-bold leading-none tracking-[-0.06em] min-[390px]:text-[46px]">
						{selectedToken === "USDC" ? <span className="mr-1 align-top text-[23px] text-text-muted">$</span> : null}
						{hideBalance ? "••••" : formatAmount(available, selectedToken)}
						{selectedToken !== "USDC" ? <span className="ml-2 text-[16px] tracking-normal text-text-muted">{selectedToken}</span> : null}
					</p>
				)}
				<p className="mt-2 text-[11px] text-text-faint">{selectedToken} · {selectedChain?.name ?? activeNetwork.name} · {selectedToken === "USDC" ? t("home.availableHint") : t("home.assetBalanceHint")}</p>
				<div className="meli-growth-rail mt-6" aria-hidden="true"><span style={{ width: Number(growing || "0") > 0 ? "33%" : "6%" }} /></div>
				<div className="mt-3 flex items-center justify-between gap-3 text-[11px]">
					<span className="flex items-center gap-2 text-text-muted"><i className="h-2 w-2 bg-growth" aria-hidden="true" />{t("home.growing")}</span>
					<strong className="font-mono text-[11px]">{growing === null || growing === undefined ? "—" : hideBalance ? "••••" : `${formatNumber(growing, 2)} USDC`}</strong>
				</div>
			</section>
			{selectedChain?.account?.status === "active" && !selectedChainOperational ? (
				<div className="mt-4 border-2 border-pending bg-pending/10 p-4 text-left" role="status">
					<strong className="font-display text-[14px] text-pending">{t("home.chainPaused")}</strong>
					<small className="mt-1 block text-[11px] leading-relaxed text-text-muted">{t("home.chainPausedBody", { network: selectedChain.name })}</small>
				</div>
			) : !selectedChainSecurityCurrent ? (
				<LinkButton
					to={`/settings/security?returnTo=${encodeURIComponent(`/send?chainKey=${selectedChain?.key ?? activeNetwork.key}&asset=${selectedToken}`)}`}
					className="mt-4 block border-2 border-pending bg-pending/10 p-4 text-left"
				>
					<strong className="font-display text-[14px] text-pending">{t("home.chainSecurityRequired")}</strong>
					<small className="mt-1 block text-[11px] leading-relaxed text-text-muted">{t("home.chainSecurityRequiredBody", { network: selectedChain?.name })}</small>
				</LinkButton>
			) : null}

			<div className="meli-quick-grid mt-6">
				<HomeAction to="/charge" label={t("home.request")} icon={<RequestIcon />} />
				<HomeAction
					to={selectedChainExecutionReady
						? `/send?chainKey=${encodeURIComponent(selectedChain?.key ?? activeNetwork.key)}&asset=${encodeURIComponent(selectedToken)}`
						: `/settings/security?returnTo=${encodeURIComponent(`/send?chainKey=${selectedChain?.key ?? activeNetwork.key}&asset=${selectedToken}`)}`}
					label={t("home.send")}
					icon={<SendIcon />}
					disabled={!selectedChainOperational}
				/>
				<HomeAction
					to={`/swap?chainKey=${encodeURIComponent(selectedChain?.key ?? activeNetwork.key)}&asset=${encodeURIComponent(selectedToken)}`}
					label={t("move.swapTitle")}
					icon={<SwapIcon />}
					disabled={!selectedChainExecutionReady || !selectedChain?.swapEnabled}
				/>
				<HomeAction to="/scan" label={t("home.scan")} icon={<ScanIcon />} />
			</div>
			{selectedChainExecutionReady && !selectedChain?.swapEnabled ? (
				<p className="mt-2 text-center text-[10px] leading-relaxed text-text-faint">
					{t("home.swapUnavailableOnNetwork", { network: selectedChain?.name })}
				</p>
			) : null}

			<LinkButton to="/move" className="meli-path-card-app interactive-surface mt-5 min-h-[88px] p-4 text-left">
				<span aria-hidden="true"><MoveIcon /></span>
				<span className="min-w-0"><strong className="block font-display text-[17px]">{t("home.moveMoney")}</strong><small className="mt-1 block text-[11px] leading-relaxed text-text-muted">{t("home.moveMoneyHint")}</small></span>
				<span aria-hidden="true" className="font-mono text-[18px] font-bold">→</span>
			</LinkButton>
			{selectedChain?.account?.status === "active" ? (
				<div className="mt-4 flex items-center justify-center gap-2 font-mono text-[9px] uppercase tracking-[0.08em] text-text-faint">
					<span>
						{!selectedObservedAt
							? t("home.balanceUnavailable")
							: selectedBalanceStatus === "fresh" &&
						(selectedChain?.key !== activeNetwork.key || !fromLocalCache)
							? t("home.dataFresh")
							: t("home.dataCached")}
						{(selectedChain?.key === activeNetwork.key
							? isValidating
							: isPortfolioValidating) && !selectedBalanceRefreshing ? " · …" : ""}
					</span>
					<span aria-hidden="true">·</span>
					<button
						type="button"
						onClick={() => void handleBalanceRefresh()}
						disabled={selectedBalanceRefreshing}
						className="underline decoration-current underline-offset-2 disabled:cursor-wait disabled:opacity-60"
					>
						{selectedBalanceRefreshing
							? t("home.refreshingBalance")
							: t("home.refreshBalance")}
					</button>
				</div>
			) : null}

			<LinkButton to={`/earn?chainKey=${encodeURIComponent(selectedChain?.key ?? activeNetwork.key)}`} className="meli-paper-card meli-paper-card--strong interactive-surface relative mt-7 grid min-h-[150px] grid-cols-[1fr_88px] items-center gap-3 overflow-hidden p-5 text-left">
				<div>
					<p className="meli-kicker mb-3">{t("home.growing")}</p>
					<p className="font-display text-[27px] leading-none tabular">{growing === null || growing === undefined ? "—" : hideBalance ? "••••" : `${formatNumber(growing, 2)} USDC`}</p>
					<p className="mt-3 text-[12px] leading-relaxed text-text-muted">{Number(growing || "0") > 0 ? t("home.growingActive") : t("home.growingEmpty")}</p>
					<p className="mt-1 font-mono text-[9px] uppercase tracking-[0.06em] text-text-faint">Aave V3 · {t("home.variableRate")}</p>
				</div>
				<MeliSprite name="body-sleeping" className="w-24 translate-y-3" />
			</LinkButton>

			<button type="button" onClick={() => setCardInterestOpen(true)} className="meli-ink-card interactive-surface relative mt-6 min-h-[190px] w-full overflow-hidden p-5 text-left">
				<p className="meli-kicker mb-3 !text-cat-500">GatoPago Card</p>
				<h2 className="max-w-[260px] font-display text-[22px]">{t("home.cardTitle")}</h2>
				<p className="mt-3 max-w-[245px] text-[12px] leading-relaxed text-[rgb(255_248_240/.64)]">{t("home.cardBody")}</p>
				<span className="mt-5 inline-flex border border-[rgb(255_248_240/.28)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.06em] text-[#fff8f0]">{cardInterestSaved ? t("home.cardUpdate") : t("home.cardCta")} →</span>
				<MeliSprite name="body-peek-card" className="pointer-events-none absolute -bottom-5 -right-8 w-36" />
			</button>

			<section className="meli-paper-card mt-7" aria-labelledby="recent-heading">
				<div className="flex items-center justify-between border-b border-border px-4 py-3"><h2 id="recent-heading" className="font-display text-[18px]">{t("home.recentActivity")}</h2>{isValidating && home?.activity ? <span className="h-2 w-2 bg-cat-500 animate-pulse" /> : null}</div>
				{isLoading && !home?.activity ? <div className="p-3"><RowSkeletonList count={RECENT_COUNT} /></div> : transactions.length === 0 ? (
					<div className="px-6 py-7 text-center"><MeliSprite name="head-curious" className="mx-auto mb-3 w-16" /><p className="text-[14px] font-semibold">{t("home.noActivity")}</p><p className="mt-1 text-[12px] leading-relaxed text-text-muted">{t("home.noActivityBodyNew")}</p></div>
				) : <div className="flex flex-col">{transactions.slice(0, RECENT_COUNT).map((tx) => <ActivityRow key={tx.id} tx={tx} hideAmount={hideBalance} onOpen={() => setSelectedTx(tx)} />)}</div>}
			</section>
			<LinkButton to="/statement" className="btn btn-ghost btn-block mt-4">{t("home.viewAllActivity")}</LinkButton>

			<PrimaryNav />
			{detailsOpen ? <AccountDetailsSheet walletAddress={walletAddress} chains={chainPortfolio?.chains ?? []} onClose={() => setDetailsOpen(false)} /> : null}
			{cardInterestOpen ? <Suspense fallback={null}><CardInterestSheet user={user} onClose={() => setCardInterestOpen(false)} onSaved={() => setCardInterestSaved(true)} /></Suspense> : null}
			{selectedTx ? <ReceiptModal tx={selectedTx} onClose={() => setSelectedTx(null)} /> : null}
			{menuOpen ? <MenuSheet user={user} username={username} onClose={() => setMenuOpen(false)} /> : null}
		</main>
	);
}

function AccountDetailsSheet({ walletAddress, chains, onClose }: { walletAddress: string | null; chains: ChainPortfolioItem[]; onClose: () => void }) {
	const { t } = useTranslation();
	const dialogRef = useDialog<HTMLDivElement>(onClose);
	const activeChains = chains.filter((chain) => chain.account?.status === "active");
	const displayedChains = activeChains.length > 0 ? activeChains : [{
		key: activeNetwork.key,
		chainId: activeNetwork.chainId,
		name: activeNetwork.name,
		explorerBaseUrl: activeNetwork.explorerBaseUrl,
		account: walletAddress ? { walletAddress } : null,
	}] as Array<Pick<ChainPortfolioItem, "key" | "chainId" | "name" | "explorerBaseUrl"> & { account: { walletAddress: string } | null }>;
	function copyAddress(address: string) {
		void navigator.clipboard.writeText(address).then(() => notifySuccess(t("settings.addressCopied")));
	}
	return createPortal(
		<div className="dialog-backdrop fixed inset-0 z-50 flex items-end justify-center px-5" style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }} onClick={onClose}>
			<div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="account-details-title" tabIndex={-1} onClick={(event) => event.stopPropagation()} className="dialog-panel w-full max-w-sm p-5 animate-sheet-up">
				<div className="sheet-handle mb-5" aria-hidden="true" />
				<div className="mb-5 flex items-start justify-between"><div><p className="meli-kicker">{activeNetwork.isTestnet ? t("home.alphaMultichain") : t("home.account")}</p><h2 id="account-details-title" className="mt-2 font-display text-[24px]">{t("home.technicalDetails")}</h2></div><button type="button" onClick={onClose} aria-label={t("common.close")} className="meli-square-action h-11 w-11">×</button></div>
				<div className="flex flex-col gap-3">
					{displayedChains.map((chain) => chain.account ? (
						<section key={chain.chainId} className="border border-border p-3 text-[13px]">
							<p className="font-display text-[15px]">{chain.name}</p>
							<p className="mt-1 font-mono text-[9px] uppercase tracking-[0.08em] text-text-faint">Chain ID {chain.chainId}</p>
							<p className="mt-3 break-all font-mono text-[11px] text-text">{chain.account.walletAddress}</p>
							<div className="mt-3 grid grid-cols-2 gap-2"><button type="button" onClick={() => copyAddress(chain.account!.walletAddress)} className="btn btn-ghost">{t("common.copy")}</button><a href={`${chain.explorerBaseUrl}/address/${chain.account.walletAddress}`} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">{t("settings.viewExplorer")}</a></div>
						</section>
					) : null)}
				</div>
				<p className="mt-4 text-[11px] leading-relaxed text-text-faint">{t("home.accountChainsBody")}</p>
			</div>
		</div>,
		document.body,
	);
}

function HomeAction({ to, label, icon, disabled = false }: { to: string; label: string; icon: ReactNode; disabled?: boolean }) {
	if (disabled) {
		return <button type="button" disabled aria-label={label} className="meli-quick-action opacity-45"><span aria-hidden="true">{icon}</span><span>{label}</span></button>;
	}
	return <LinkButton to={to} className="meli-quick-action"><span aria-hidden="true">{icon}</span><span>{label}</span></LinkButton>;
}

const ChevronDown = () => <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m6 9 6 6 6-6" /></svg>;
const ScanIcon = () => <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M3 12h18" /></svg>;
const EyeIcon = () => <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>;
const EyeOffIcon = () => <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a16.9 16.9 0 0 1-3.3 4.1M6.6 6.6A16.8 16.8 0 0 0 2 12s3.5 7 10 7a10.3 10.3 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" /></svg>;
const MoveIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 7h11m-3-3 3 3-3 3M17 17H6m3-3-3 3 3 3" /></svg>;
const SwapIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M7 4v16m-4-4 4 4 4-4M17 20V4m-4 4 4-4 4 4" /></svg>;
const SendIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20V6m-6 6 6-6 6 6" /></svg>;
const RequestIcon = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M12 8v8M8 12h8" /></svg>;

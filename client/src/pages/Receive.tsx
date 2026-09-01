// One account destination for wallets and exchanges. The normal same-network
// transfer stays primary; CCTP is revealed only when the sender starts elsewhere.

import { useState } from "react";
import type { User } from "../lib/firebase";
import { QRCodeSVG } from "qrcode.react";
import { notifyError, notifySuccess } from "../lib/notify";
import { useTranslation } from "react-i18next";
import Logo from "../components/Logo";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import AddressQRCard from "../components/AddressQRCard";
import { DetailPageSkeleton } from "../components/Skeleton";
import { useAccountProfile } from "../hooks/useAccountProfile";
import NoticeCard from "../components/NoticeCard";
import { MoneyPanel, SectionLabel } from "../components/finance/FinancialPrimitives";
import { activeNetwork } from "../lib/activeNetwork";
import { apiFetch } from "../lib/api";
import { getNetworkConfig, isSupportedChainKey } from "../lib/networks";
import { useChainPortfolio, type ChainPortfolio, type ChainPortfolioItem } from "../hooks/useChainPortfolio";
import NetworkChips from "../components/NetworkChips";
import TokenSelect from "../components/TokenSelect";

function readInitialSelection() {
	const params = new URLSearchParams(window.location.search);
	const requestedChainKey = params.get("chainKey");
	const chainKey = requestedChainKey && isSupportedChainKey(requestedChainKey)
		? requestedChainKey
		: activeNetwork.key;
	const network = getNetworkConfig(chainKey);
	const requestedAsset = params.get("asset")?.toUpperCase() ?? null;
	return {
		chainKey,
		asset: requestedAsset && network.currencies.includes(requestedAsset)
			? requestedAsset
			: network.currencies[0] ?? "USDC",
	};
}

export default function Receive({
	user,
	previewPortfolio,
}: {
	user: User;
	previewPortfolio?: ChainPortfolio;
}) {
	const { t } = useTranslation();
	const { profile, loading } = useAccountProfile(user);
	const {
		data: portfolio,
		error: portfolioError,
		isLoading: portfolioLoading,
		mutate: refreshPortfolio,
	} = useChainPortfolio(user, previewPortfolio);
	const username = profile?.username ?? null;
	const [showCrosschain, setShowCrosschain] = useState(false);
	const [initialSelection] = useState(readInitialSelection);
	const [selectedChainKey, setSelectedChainKey] = useState(initialSelection.chainKey);
	const [selectedAsset, setSelectedAsset] = useState(initialSelection.asset);
	const [activating, setActivating] = useState(false);
	const fallbackHome: ChainPortfolioItem = {
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
		account: profile?.walletAddress ? {
			walletAddress: profile.walletAddress,
			status: "active",
			securityStatus: "current",
			securityVersionApplied: 1,
			securityVersionDesired: 1,
		} : null,
		balance: { assets: [] },
	};
	const chains = portfolio?.chains.length ? portfolio.chains : [fallbackHome];
	const selectedChain = chains.find((chain) => chain.key === selectedChainKey) ?? chains[0] ?? fallbackHome;
	const selectedNetwork = getNetworkConfig(selectedChain.key);
	const receiveAsset = selectedNetwork.currencies.includes(selectedAsset)
		? selectedAsset
		: selectedNetwork.currencies[0] ?? "USDC";
	const walletAddress = selectedChain.account?.status === "active"
		? selectedChain.account.walletAddress
		: null;

	const homeAddress = chains.find((chain) => chain.key === activeNetwork.key)?.account?.walletAddress
		?? profile?.walletAddress
		?? null;
	const ccLink = homeAddress ? `${window.location.origin}/cc/${username || homeAddress}` : "";

	function copy(text: string, msg: string) {
		navigator.clipboard.writeText(text).then(() => notifySuccess(msg));
	}

	function shareLink() {
		if (navigator.share) {
			navigator.share({ url: ccLink }).catch(() => {});
		} else {
			copy(ccLink, t("receive.linkCopied"));
		}
	}

	async function activateSelectedChain() {
		if (!isSupportedChainKey(selectedChain.key) || activating) return;
		setActivating(true);
		try {
			await apiFetch(`/account/chains/${encodeURIComponent(selectedChain.key)}/activate`, {
				user,
				method: "POST",
			});
			await refreshPortfolio();
			notifySuccess(t("receive.activationStarted"));
		} catch (error) {
			notifyError(error, t("receive.activationError"));
		} finally {
			setActivating(false);
		}
	}

	return (
		<Screen>
			<BackHeader title={t("receive.title")} />

			{loading || (portfolioLoading && !portfolio) ? (
				<DetailPageSkeleton />
			) : portfolioError && !portfolio ? (
				<div className="flex-1 flex flex-col justify-center px-1">
					<NoticeCard tone="warning" title={t("receive.portfolioUnavailable")}>
						{t("receive.portfolioUnavailableDesc")}
					</NoticeCard>
					<button
						type="button"
						onClick={() => void refreshPortfolio()}
						className="btn btn-primary btn-block mt-4"
					>
						{t("common.retry")}
					</button>
				</div>
			) : !profile?.walletAddress ? (
				<div className="flex-1 flex flex-col items-center justify-center text-center px-6">
					<Logo className="w-12 mb-5 opacity-40" />
					<p className="text-[14px] text-text-muted">{t("receive.noWallet")}</p>
				</div>
			) : (
				<>
					<p className="text-[14px] text-text-muted leading-relaxed mb-5">
						{t("receive.intro")}
					</p>
					<NetworkChips
						options={chains.map((chain) => ({ id: chain.chainId, label: chain.name }))}
						selected={selectedChain.chainId}
						onSelect={(chainId) => {
							const next = chains.find((chain) => chain.chainId === chainId);
							if (!next || !isSupportedChainKey(next.key)) return;
							setSelectedChainKey(next.key);
							setSelectedAsset(getNetworkConfig(next.key).currencies[0] ?? "USDC");
							setShowCrosschain(false);
						}}
					/>

					<SectionLabel>{t("receive.fromWallet")}</SectionLabel>
					<MoneyPanel className="mb-3 p-6">
						{walletAddress ? (
							<>
								<p className="text-[15px] text-text mb-1">{t("receive.assetTitle", { asset: receiveAsset, network: selectedChain.name })}</p>
								<p className="text-[13px] text-text-muted leading-relaxed mb-4">{t("receive.assetDesc", { asset: receiveAsset, network: selectedChain.name })}</p>
								<TokenSelect
									value={receiveAsset}
									options={selectedNetwork.currencies}
									onChange={setSelectedAsset}
									className="mb-5"
								/>
								<AddressQRCard address={walletAddress} chainId={selectedChain.chainId} />
								<NoticeCard title={t("receive.onlyAssetNetwork", { asset: receiveAsset, network: selectedChain.name })} className="mt-4">
									{t("receive.warnWrongNetwork", { asset: receiveAsset, network: selectedChain.name })}
								</NoticeCard>
								<p className="mt-4 text-[12px] leading-relaxed text-text-faint">
									{t("receive.exchangeAssetHint", { asset: receiveAsset, network: selectedChain.name })}
								</p>
							</>
						) : selectedChain.account?.status === "deploying" ? (
							<NoticeCard tone="info" title={t("receive.activationPending")}>{t("receive.activationPendingDesc")}</NoticeCard>
						) : selectedChain.walletRailEnabled ? (
							<div className="text-center">
								<p className="mb-4 text-[13px] leading-relaxed text-text-muted">{t("receive.activateNetworkDesc", { network: selectedChain.name })}</p>
								<button type="button" onClick={() => void activateSelectedChain()} disabled={activating} className="btn btn-primary btn-block">
									{activating ? t("receive.activating") : t("receive.activateNetwork", { network: selectedChain.name })}
								</button>
							</div>
						) : (
							<NoticeCard tone="warning" title={t("receive.networkUnavailable")}>{t("receive.networkUnavailableDesc", { network: selectedChain.name })}</NoticeCard>
						)}
					</MoneyPanel>

					{selectedChain.key === activeNetwork.key && ccLink ? <MoneyPanel className="mt-6">
						<div className="flex items-center gap-2 mb-1">
							<p className="text-[14px] text-text">{t("receive.advTitle")}</p>
							<span className="meli-chip bg-surface-2 text-text-faint">
								{t("receive.advBadge")}
							</span>
						</div>
						<p className="text-[12px] text-text-muted leading-relaxed mb-4">{t("receive.advDesc")}</p>
						<button
							type="button"
							onClick={() => setShowCrosschain((current) => !current)}
							aria-expanded={showCrosschain}
							className="btn btn-ghost btn-block text-[13px]"
						>
							{showCrosschain ? t("receive.hideCrosschainQr") : t("receive.showCrosschainQr")}
						</button>
						{showCrosschain ? (
							<div className="mt-4">
								<div className="flex justify-center mb-4" aria-label={t("receive.crosschainQr")}>
									<div className="border-2 border-text bg-white p-3 shadow-[5px_5px_0_var(--color-cat-700)]">
										<QRCodeSVG value={ccLink} size={164} bgColor="#ffffff" fgColor="#0A0A0B" level="M" />
									</div>
								</div>
								<div className="flex gap-2">
									<button onClick={() => copy(ccLink, t("receive.linkCopied"))} className="btn btn-ghost flex-1 text-[13px]">
										{t("receive.copyLink")}
									</button>
									<button onClick={shareLink} className="btn btn-ghost flex-1 text-[13px]">
										{t("receive.shareLink")}
									</button>
								</div>
							</div>
						) : null}
					</MoneyPanel> : null}

					<div className="flex-1" />
				</>
			)}
		</Screen>
	);
}

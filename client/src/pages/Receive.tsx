// One account destination for wallets and exchanges. The normal same-network
// transfer stays primary; CCTP is revealed only when the sender starts elsewhere.

import { useState } from "react";
import type { User } from "../lib/firebase";
import { QRCodeSVG } from "qrcode.react";
import { notifySuccess } from "../lib/notify";
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

export default function Receive({ user }: { user: User }) {
	const { t } = useTranslation();
	const { profile, loading } = useAccountProfile(user);
	const walletAddress = profile?.walletAddress ?? null;
	const username = profile?.username ?? null;
	const [showCrosschain, setShowCrosschain] = useState(false);

	const ccLink = walletAddress ? `${window.location.origin}/cc/${username || walletAddress}` : "";

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

	return (
		<Screen>
			<BackHeader title={t("receive.title")} />

			{loading ? (
				<DetailPageSkeleton />
			) : !walletAddress ? (
				<div className="flex-1 flex flex-col items-center justify-center text-center px-6">
					<Logo className="w-12 mb-5 opacity-40" />
					<p className="text-[14px] text-text-muted">{t("receive.noWallet")}</p>
				</div>
			) : (
				<>
					<p className="text-[14px] text-text-muted leading-relaxed mb-5">
						{t("receive.intro")}
					</p>

					<SectionLabel>{t("receive.fromWallet")}</SectionLabel>
					<MoneyPanel className="mb-3 p-6">
						<p className="text-[15px] text-text mb-1">{t("receive.arbTitle", { network: activeNetwork.name })}</p>
						<p className="text-[13px] text-text-muted leading-relaxed mb-5">{t("receive.arbDesc", { network: activeNetwork.name })}</p>

						<AddressQRCard address={walletAddress} />

						<NoticeCard title={t("receive.onlyArb", { network: activeNetwork.name })} className="mt-4">
							{t("receive.warnOtherNet", { network: activeNetwork.name })}
						</NoticeCard>
						<p className="mt-4 text-[12px] leading-relaxed text-text-faint">
							{t("receive.exchangeHint", { network: activeNetwork.name })}
						</p>
					</MoneyPanel>

					<MoneyPanel className="mt-6">
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
					</MoneyPanel>

					<div className="flex-1" />
				</>
			)}
		</Screen>
	);
}

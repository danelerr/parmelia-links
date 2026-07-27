// "Depositar" hub: the ONE place with every way to bring money into Parmelia
// (UX_DESIGN.md R-2/R-8). Primary: receive USDC directly on Arbitrum (address +
// QR). Then the guided Binance withdrawal, the Across bridge, and the advanced
// cross-chain checkout link (/cc/:user). New ramps (Daimo one-click, Bolivian
// QR) replace or join slots here - they never add Home entries.

import { useEffect, useState } from "react";
import type { User } from "../lib/firebase";
import { QRCodeSVG } from "qrcode.react";
import { SERVER_URL } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import { notifySuccess } from "../lib/notify";
import { useTranslation } from "react-i18next";
import Logo from "../components/Logo";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import AddressQRCard from "../components/AddressQRCard";
import OptionCard from "../components/OptionCard";
import { Spinner } from "../components/icons";

export default function Receive({ user }: { user: User }) {
	const { t } = useTranslation();
	const [walletAddress, setWalletAddress] = useState<string | null>(null);
	const [username, setUsername] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		(async () => {
			try {
				const res = await fetchWithAuth(user, `${SERVER_URL}/user/profile`);
				if (res.ok) {
					const data = await res.json();
					setWalletAddress(data.walletAddress || null);
					setUsername(data.username || null);
				}
			} catch {
				/* non-blocking */
			} finally {
				setLoading(false);
			}
		})();
	}, [user]);

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
			<BackHeader to="/" title={t("receive.title")} />

			{loading ? (
				<div className="flex-1 flex items-center justify-center">
					<Spinner />
				</div>
			) : !walletAddress ? (
				<div className="flex-1 flex flex-col items-center justify-center text-center px-6">
					<Logo className="w-12 mb-5 opacity-40" />
					<p className="text-[14px] text-text-muted">{t("receive.noWallet")}</p>
				</div>
			) : (
				<>
					{/* PRIMARY: receive on Arbitrum */}
					<div className="bg-surface border border-border rounded-[20px] p-6 mb-3 shadow-e1">
						<p className="text-[15px] text-text mb-1">{t("receive.arbTitle")}</p>
						<p className="text-[13px] text-text-muted leading-relaxed mb-5">{t("receive.arbDesc")}</p>

						<AddressQRCard address={walletAddress} />

						<div className="mt-4 flex items-start gap-2 rounded-[12px] bg-sky/8 border border-sky/20 px-3.5 py-3">
							<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ce3f4" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
								<circle cx="12" cy="12" r="10" />
								<path d="M12 16v-4M12 8h.01" />
							</svg>
							<p className="text-[12px] text-text-muted leading-relaxed">
								<span className="text-glow-sky font-medium">{t("receive.onlyArb")}.</span> {t("receive.warnOtherNet")}
							</p>
						</div>
					</div>

					{/* Other ways in (slots per UX_DESIGN.md R-8) */}
					<div className="flex flex-col gap-2.5 mb-3">
						<OptionCard
							accent="#efe08c"
							title={t("createLink.optBinanceTitle")}
							desc={t("createLink.optBinanceDesc")}
							to="/deposit/binance"
							icon={
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
									<path d="m12 3 9 9-9 9-9-9 9-9Z" />
									<circle cx="12" cy="12" r="2.5" />
								</svg>
							}
						/>
						{/* Across (/deposit) unlinked jul-2026 (CROSSCHAIN Fase 1): disabled
						    on testnet; the CCTP checkout below covers "from another network". */}
					</div>

					{/* ADVANCED: cross-chain checkout link */}
					<div className="bg-surface border border-border rounded-[18px] p-5">
						<div className="flex items-center gap-2 mb-1">
							<p className="text-[14px] text-text">{t("receive.advTitle")}</p>
							<span className="text-[10px] uppercase tracking-wide text-text-faint border border-border rounded-full px-2 py-0.5">
								{t("receive.advBadge")}
							</span>
						</div>
						<p className="text-[12px] text-text-muted leading-relaxed mb-4">{t("receive.advDesc")}</p>
						<div
							className="flex justify-center mb-4"
							aria-label={t("receive.crosschainQr")}
						>
							<div className="bg-white rounded-[16px] p-3">
								<QRCodeSVG
									value={ccLink}
									size={164}
									bgColor="#ffffff"
									fgColor="#0A0A0B"
									level="M"
								/>
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

					<div className="flex-1" />
				</>
			)}
		</Screen>
	);
}

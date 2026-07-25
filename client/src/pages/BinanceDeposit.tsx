// Guided "deposit from Binance" - fully self-custodial. Binance can withdraw USDC
// natively on Arbitrum (our home chain), the indexer already credits incoming
// USDC + pushes "deposit received", so this is purely a guided UX on top of what
// already works: numbered steps + address/QR + a hard network warning. No backend,
// no custody, no merchant account. NOT a one-tap (Binance always asks to confirm
// the withdrawal - which is correct for security).

import { useEffect, useState } from "react";
import type { User } from "../lib/firebase";
import { SERVER_URL } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import { activeNetwork } from "../lib/activeNetwork";
import { SUPPORT_URL } from "../lib/support";
import { useTranslation } from "react-i18next";
import Logo from "../components/Logo";
import Screen from "../components/Screen";
import BackHeader from "../components/BackHeader";
import AddressQRCard from "../components/AddressQRCard";
import { Spinner } from "../components/icons";

// Best-effort: lands on Binance's crypto withdrawal page (if signed in). Binance
// exposes no third-party deep link that pre-fills network/address/amount, so the
// real low-friction win is the copy + QR + network lock below.
const BINANCE_WITHDRAW_URL = "https://www.binance.com/en/my/wallet/account/main/withdrawal/crypto/USDC";
// Android: open the Binance APP via intent:// with Binance's OWN scheme (bnc).
// With scheme=https Chrome treats the target as browsable and opens the web
// tab; bnc:// is resolvable ONLY by the app, so Chrome launches it (worst case
// at its home screen) or uses the web fallback when it isn't installed.
const BINANCE_ANDROID_INTENT =
	"intent://app.binance.com/en/my/wallet/account/main/withdrawal/crypto/USDC#Intent;scheme=bnc;package=com.binance.dev;S.browser_fallback_url=" +
	encodeURIComponent(BINANCE_WITHDRAW_URL) +
	";end";

function openBinance() {
	if (/android/i.test(navigator.userAgent)) {
		window.location.href = BINANCE_ANDROID_INTENT;
		return;
	}
	window.open(BINANCE_WITHDRAW_URL, "_blank", "noopener");
}

export default function BinanceDeposit({ user }: { user: User }) {
	const { t } = useTranslation();
	const [walletAddress, setWalletAddress] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		(async () => {
			try {
				const res = await fetchWithAuth(user, `${SERVER_URL}/user/profile`);
				if (res.ok) {
					const data = await res.json();
					setWalletAddress(data.walletAddress || null);
				}
			} catch {
				/* non-blocking */
			} finally {
				setLoading(false);
			}
		})();
	}, [user]);

	const steps = [
		t("binanceDeposit.step1"),
		t("binanceDeposit.step2", { network: activeNetwork.name }),
		t("binanceDeposit.step3"),
		t("binanceDeposit.step4"),
	];

	return (
		<Screen>
			<BackHeader to="/receive" title={t("binanceDeposit.title")} className="mb-6" />

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
					{/* Badges */}
					<div className="flex flex-wrap gap-2 mb-5">
						{[t("binanceDeposit.badgeNoFee"), t("binanceDeposit.badgeTime"), t("binanceDeposit.badgeSelfCustody")].map((b) => (
							<span key={b} className="text-[12px] text-text-muted bg-surface border border-border rounded-full px-3 py-1">
								{b}
							</span>
						))}
					</div>

					{/* Steps */}
					<div className="bg-surface border border-border rounded-[20px] p-6 mb-3 shadow-e1">
						<ol className="flex flex-col gap-4">
							{steps.map((step, i) => (
								<li key={i} className="flex items-start gap-3">
									<span className="w-6 h-6 rounded-full bg-sky/15 text-glow-sky text-[12px] font-medium flex items-center justify-center shrink-0 mt-0.5">
										{i + 1}
									</span>
									<p className="text-[14px] text-text leading-relaxed">{step}</p>
								</li>
							))}
						</ol>
					</div>

					{/* Address + QR */}
					<div className="bg-surface border border-border rounded-[20px] p-6 mb-3 shadow-e1">
						<AddressQRCard address={walletAddress} qrSize={172} label={t("binanceDeposit.yourAddress")} />
					</div>

					{/* Hard network warning */}
					<div className="flex items-start gap-2 rounded-[14px] bg-pink/8 border border-pink/25 px-3.5 py-3 mb-5">
						<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f4a9cf" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 mt-0.5">
							<path d="M12 9v4M12 17h.01" />
							<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
						</svg>
						<p className="text-[12px] text-text-muted leading-relaxed">
							<span className="text-glow-pink font-medium">{t("binanceDeposit.warnTitle", { network: activeNetwork.name })}.</span>{" "}
							{t("binanceDeposit.warnBody")}
						</p>
					</div>

					<div className="flex-1" />

					<button onClick={openBinance} className="btn btn-primary btn-block">
						{t("binanceDeposit.openBinance")}
					</button>
					<a
					href={SUPPORT_URL}
					target="_blank"
					rel="noopener noreferrer"
					className="text-[12px] text-text-faint text-center mt-3 underline underline-offset-2"
				>
					{t("binanceDeposit.supportNote")}
				</a>
				</>
			)}
		</Screen>
	);
}

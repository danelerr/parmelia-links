import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router";
import Screen from "../components/Screen";
import OptionCard from "../components/OptionCard";
import LinkButton from "../components/LinkButton";
import PrimaryNav from "../components/PrimaryNav";
import { SectionLabel } from "../components/finance/FinancialPrimitives";
import MeliSprite from "../components/brand/MeliSprite";
import PixelRail from "../components/brand/PixelRail";

const icon = (children: React.ReactNode) => (
	<svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

export default function Move() {
	const { t } = useTranslation();
	const [searchParams] = useSearchParams();
	const isReceiving = searchParams.get("flow") === "receive";

	if (isReceiving) {
		return (
			<Screen withPrimaryNav>
				<header className="mb-4">
					<LinkButton to="/move" className="meli-square-action mb-6 px-3 text-[12px]">
						<span aria-hidden="true">←</span>{t("move.backToMove")}
					</LinkButton>
					<div className="flex items-end gap-3"><div className="min-w-0 flex-1"><p className="meli-kicker mb-3">{t("move.eyebrow")}</p><h1 className="font-display text-[34px] leading-[.96]">{t("move.receiveOptionsTitle")}</h1><p className="mt-3 text-[13px] leading-relaxed text-text-muted">{t("move.receiveOptionsIntro")}</p></div><MeliSprite name="body-qr" className="w-24 shrink-0" motion="idle" /></div>
				</header>
				<PixelRail state="future" className="mb-5" />

				<div className="flex flex-col gap-2.5">
					<OptionCard to="/charge" title={t("move.collectTitle")} desc={t("move.collectDesc")} tone="brand" icon={icon(<><path d="M12 8v8" /><path d="M8 12h8" /><rect x="3" y="4" width="18" height="16" rx="3" /></>)} />
					<OptionCard to="/receive" title={t("move.accountReceiveTitle")} desc={t("move.accountReceiveDesc")} tone="info" icon={icon(<><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>)} />
				</div>

				<PrimaryNav />
			</Screen>
		);
	}

	return (
		<Screen withPrimaryNav>
			<header className="mb-4 flex items-end gap-3">
				<div className="min-w-0 flex-1"><p className="meli-kicker mb-3">{t("move.eyebrow")}</p><h1 className="font-display text-[36px] leading-[.94]">{t("move.title")}</h1><p className="mt-3 text-[13px] leading-relaxed text-text-muted">{t("move.intro")}</p></div>
				<MeliSprite name="body-courier" className="w-24 shrink-0" motion="deliver" />
			</header>
			<PixelRail state="idle" className="mb-5" />

			<SectionLabel>{t("move.chooseAction")}</SectionLabel>
			<div className="flex flex-col gap-2.5">
				<OptionCard to="/move?flow=receive" title={t("move.receiveMoneyTitle")} desc={t("move.receiveMoneyDesc")} tone="info" icon={icon(<><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>)} />
				<OptionCard to="/send" title={t("move.sendOrWithdrawTitle")} desc={t("move.sendOrWithdrawDesc")} tone="brand" icon={icon(<><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></>)} />
				<OptionCard to="/swap" title={t("move.swapTitle")} desc={t("move.swapDesc")} tone="neutral" icon={icon(<><path d="M7 4v16" /><path d="m3 8 4-4 4 4" /><path d="M17 20V4" /><path d="m13 16 4 4 4-4" /></>)} />
			</div>

			<PrimaryNav />
		</Screen>
	);
}

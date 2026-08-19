import { useEffect, useState } from "react";
import { type User, logOut } from "../lib/firebase";
import { notifyError, notifySuccess, notifyWarning } from "../lib/notify";
import { enablePush, pushAlreadyEnabled, pushSupported } from "../lib/push";
import BackHeader from "../components/BackHeader";
import Screen from "../components/Screen";
import { useTranslation } from "react-i18next";
import i18n from "../lib/i18n";
import { SettingsSection as Section } from "../components/SettingsSection";

const ICON = {
	bell: (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
			<path d="M13.73 21a2 2 0 0 1-3.46 0" />
		</svg>
	),
	globe: (
		<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<circle cx="12" cy="12" r="10" />
			<path d="M2 12h20" />
			<path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10Z" />
		</svg>
	),
};

export default function Settings({ user }: { user: User }) {
	const { t } = useTranslation();
	const isSpanish = (i18n.resolvedLanguage || i18n.language || "es").startsWith("es");
	const [pushOn, setPushOn] = useState(pushAlreadyEnabled());
	const [pushAvailable, setPushAvailable] = useState(false);
	const [pushBusy, setPushBusy] = useState(false);

	useEffect(() => {
		void pushSupported().then(setPushAvailable);
	}, []);

	async function handleEnablePush() {
		setPushBusy(true);
		try {
			const ok = await enablePush(user);
			if (ok) {
				setPushOn(true);
				notifySuccess(t("settings.pushOnTitle"), t("settings.pushOnDesc"));
			} else {
				notifyWarning(
					t("settings.pushFailTitle"),
					t("settings.pushFailDesc"),
				);
			}
		} catch (err) {
			notifyError(err, t("settings.pushError"));
		} finally {
			setPushBusy(false);
		}
	}

	return (
		<Screen className="pb-[calc(env(safe-area-inset-bottom)_+_3rem)]">
			<BackHeader title={t("common.settings")} />
			<div className="animate-fade-up">
					{/* Notifications */}
					{pushAvailable && !pushOn && (
						<Section title={t("settings.notifications")} icon={ICON.bell} tone="info">
							<div className="p-5">
								<p className="text-[13px] text-text-muted leading-relaxed mb-3">
									{t("settings.pushIntro")}
								</p>
								<button
									onClick={handleEnablePush}
									disabled={pushBusy}
									className="btn btn-primary btn-sm"
								>
									{pushBusy ? t("settings.activating") : t("settings.enablePush")}
								</button>
							</div>
						</Section>
					)}
					{pushOn && (
						<Section title={t("settings.notifications")} icon={ICON.bell} tone="growth">
							<div className="p-5 flex items-center gap-2.5">
								<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="text-growth">
									<polyline points="20 6 9 17 4 12" />
								</svg>
								<p className="text-[14px] text-text-muted">{t("settings.pushEnabled")}</p>
							</div>
						</Section>
					)}

					{/* Language */}
						<Section title={t("settings.language")} icon={ICON.globe} tone="neutral">
							<div className="p-5">
								<p className="text-[13px] text-text-muted mb-3">{t("settings.languageDesc")}</p>
								<div className="seg-track seg-track-block">
									<button
										onClick={() => void i18n.changeLanguage("es")}
										aria-pressed={isSpanish}
										data-active={isSpanish}
										className="seg-item"
									>
										Español
									</button>
									<button
										onClick={() => void i18n.changeLanguage("en")}
										aria-pressed={!isSpanish}
										data-active={!isSpanish}
										className="seg-item"
									>
										English
									</button>
								</div>
							</div>
						</Section>

						{/* Logout */}
					<button
						onClick={() => logOut()}
						className="btn btn-danger btn-block"
					>
						{t("settings.logout")}
					</button>
				</div>
		</Screen>
	);
}

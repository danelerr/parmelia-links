import { NavLink } from "react-router";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";

const destinations = [
	{ to: "/", key: "home", end: true, icon: <HomeIcon /> },
	{ to: "/move", key: "move", end: false, icon: <MoveIcon /> },
	{ to: "/earn", key: "grow", end: false, icon: <GrowIcon /> },
	{ to: "/statement", key: "activity", end: false, icon: <ActivityIcon /> },
] as const;

export default function PrimaryNav() {
	const { t } = useTranslation();
	return createPortal(
		<nav
			aria-label={t("nav.aria")}
			className="primary-nav fixed inset-x-0 bottom-0 z-30 mx-auto w-full max-w-[480px] px-2 pt-2"
			style={{ paddingBottom: "max(0.65rem, env(safe-area-inset-bottom))" }}
		>
			<div className="grid grid-cols-4 gap-1">
				{destinations.map((item) => (
					<NavLink
						key={item.to}
						to={item.to}
						end={item.end}
						viewTransition
						className={({ isActive }) =>
							`primary-nav__item relative flex min-h-13 flex-col items-center justify-center gap-1 text-[10px] font-semibold ${
								isActive ? "is-active" : ""
							}`
						}
					>
						<span aria-hidden="true">{item.icon}</span>
						<span>{t(`nav.${item.key}`)}</span>
					</NavLink>
				))}
			</div>
		</nav>,
		document.body,
	);
}

function HomeIcon() {
	return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 11 9-8 9 8" /><path d="M5 10v10h14V10" /><path d="M9 20v-6h6v6" /></svg>;
}

function MoveIcon() {
	return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 7h11" /><path d="m15 4 3 3-3 3" /><path d="M17 17H6" /><path d="m9 14-3 3 3 3" /></svg>;
}

function GrowIcon() {
	return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20V10" /><path d="M10 20V4" /><path d="M16 20v-7" /><path d="M22 20H2" /></svg>;
}

function ActivityIcon() {
	return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><path d="m7 15 4-4 3 3 5-6" /></svg>;
}

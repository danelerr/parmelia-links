// The one back-navigation header. Declarative destinations use `to`
// (LinkButton + view transition); conditional/back-step behavior uses
// `onClick`. Title is optional (result screens show only the arrow).

import { useTranslation } from "react-i18next";
import { useViewTransitionNavigate } from "../hooks/useNav";
import LinkButton from "./LinkButton";
import { IconBack } from "./icons";

const BTN =
	"meli-square-action -ml-1 h-11 w-11 text-text";

export default function BackHeader({
	to,
	onClick,
	title,
	className = "mb-7",
	ariaLabel,
	fallbackTo = "/",
	replace = false,
}: {
	to?: string;
	onClick?: () => void;
	/** Destination used only when this page was opened without app history. */
	fallbackTo?: string;
	title?: string;
	className?: string;
	ariaLabel?: string;
	/** Replace history when this is a terminal screen that should not reopen on Back. */
	replace?: boolean;
}) {
	const { t } = useTranslation();
	const navigate = useViewTransitionNavigate();
	const label = ariaLabel ?? t("common.back");
	const handleBack = onClick ?? (() => {
		const historyIndex = Number(window.history.state?.idx);
		if (Number.isFinite(historyIndex) && historyIndex > 0) {
			navigate(-1);
		} else {
			// A direct entry has no in-app page to return to. Replacing instead of
			// pushing prevents fallback parent/child loops (for example, opening
			// Binance directly, falling back to Depositar, then returning to Binance).
			navigate(fallbackTo, { replace: true });
		}
	});
	return (
		<header className={`flex items-center gap-3 ${className}`}>
			{to !== undefined ? (
				<LinkButton to={to} replace={replace} aria-label={label} className={BTN}>
					<IconBack />
				</LinkButton>
			) : (
				<button type="button" onClick={handleBack} aria-label={label} className={BTN}>
					<IconBack />
				</button>
			)}
			{title ? <h1 className="text-[22px] min-w-0 text-balance">{title}</h1> : null}
		</header>
	);
}

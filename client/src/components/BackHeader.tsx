// The one back-navigation header. Back destinations are deterministic: relying
// on browser history can bounce through auth redirects or aliases forever.
// Conditional in-page steps still use `onClick`.

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
	replace = true,
}: {
	to?: string;
	onClick?: () => void;
	/** Destination used only when this page was opened without app history. */
	fallbackTo?: string;
	title?: string;
	className?: string;
	ariaLabel?: string;
	/** Back links replace by default so the child cannot be reopened in a loop. */
	replace?: boolean;
}) {
	const { t } = useTranslation();
	const navigate = useViewTransitionNavigate();
	const label = ariaLabel ?? t("common.back");
	const handleBack = onClick ?? (() => {
		// Replace so repeated taps and redirect aliases cannot build a parent/child
		// cycle in the history stack.
		navigate(fallbackTo, { replace: true });
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

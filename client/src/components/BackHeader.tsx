// The one back-navigation header. Declarative destinations use `to`
// (LinkButton + view transition); conditional/back-step behavior uses
// `onClick`. Title is optional (result screens show only the arrow).

import { useTranslation } from "react-i18next";
import LinkButton from "./LinkButton";
import { IconBack } from "./icons";

const BTN =
	"w-10 h-10 -ml-1 rounded-full flex items-center justify-center text-text-muted hover:text-text hover:bg-surface transition-colors";

export default function BackHeader({
	to,
	onClick,
	title,
	className = "mb-7",
	ariaLabel,
}: {
	to?: string;
	onClick?: () => void;
	title?: string;
	className?: string;
	ariaLabel?: string;
}) {
	const { t } = useTranslation();
	const label = ariaLabel ?? t("common.back");
	return (
		<header className={`flex items-center gap-3 ${className}`}>
			{to !== undefined ? (
				<LinkButton to={to} aria-label={label} className={BTN}>
					<IconBack />
				</LinkButton>
			) : (
				<button onClick={onClick} aria-label={label} className={BTN}>
					<IconBack />
				</button>
			)}
			{title ? <h1 className="text-[22px]">{title}</h1> : null}
		</header>
	);
}

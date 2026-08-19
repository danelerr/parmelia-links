// Shared network selector. The route decides when a network choice is relevant;
// Home never exposes this as a global wallet mode.

import { useTranslation } from "react-i18next";
import SelectMenu from "./SelectMenu";

export default function NetworkChips({
	options,
	selected,
	onSelect,
}: {
	options: { id: number; label: string }[];
	selected: number | null;
	onSelect: (id: number) => void;
}) {
	const { t } = useTranslation();
	return (
		<SelectMenu
			label={t("networkSelector.title")}
			value={selected}
			options={options.map((option) => ({
				value: option.id,
				label: option.label,
				tone: "info" as const,
			}))}
			onChange={onSelect}
			showLabel={false}
			placeholder={t("networkSelector.choose")}
			className="mb-5"
		/>
	);
}

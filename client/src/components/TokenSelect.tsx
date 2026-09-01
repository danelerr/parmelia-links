import { useTranslation } from "react-i18next";
import { formatAmount } from "../lib/format";
import SelectMenu from "./SelectMenu";
import TokenIcon from "./TokenIcon";

export default function TokenSelect({
	value,
	options,
	onChange,
	disabled = false,
	className = "",
	balances,
	hideBalances = false,
	optionDetails,
}: {
	value: string;
	options: string[];
	onChange: (value: string) => void;
	disabled?: boolean;
	className?: string;
	balances?: Record<string, string | undefined>;
	hideBalances?: boolean;
	optionDetails?: Record<string, { symbol: string; label?: string; description?: string }>;
}) {
	const { t } = useTranslation();
	return (
		<SelectMenu
			label={t("assetSelector.title")}
			value={value}
			options={options.map((option) => {
				const detail = optionDetails?.[option];
				const symbol = detail?.symbol ?? option;
				const assetName = detail?.description ?? t(`assetSelector.assets.${symbol}`, { defaultValue: t("assetSelector.supportedAsset") });
				const balance = balances?.[option];
				return {
					value: option,
					label: detail?.label ?? symbol,
					icon: <TokenIcon symbol={symbol} size={28} />,
					description: balance === undefined
						? assetName
						: `${assetName} · ${t("assetSelector.balance", {
							amount: hideBalances ? "••••" : formatAmount(balance, symbol),
							symbol,
						})}`,
				};
			})}
			onChange={onChange}
			showLabel={false}
			compact
			disabled={disabled}
			className={className}
		/>
	);
}

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
}: {
	value: string;
	options: string[];
	onChange: (value: string) => void;
	disabled?: boolean;
	className?: string;
	balances?: Record<string, string | undefined>;
	hideBalances?: boolean;
}) {
	const { t } = useTranslation();
	return (
		<SelectMenu
			label={t("assetSelector.title")}
			value={value}
			options={options.map((symbol) => {
				const assetName = t(`assetSelector.assets.${symbol}`, { defaultValue: t("assetSelector.supportedAsset") });
				const balance = balances?.[symbol];
				return {
					value: symbol,
					label: symbol,
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

import { useTranslation } from "react-i18next";
import { SectionLabel } from "../../components/finance/FinancialPrimitives";

export type CheckoutPaymentMethod = "external" | "balance";

export default function PaymentMethodSelector({
	value,
	onChange,
}: {
	value: CheckoutPaymentMethod;
	onChange: (method: CheckoutPaymentMethod) => void;
}) {
	const { t } = useTranslation();
	return (
		<div className="mb-2">
			<SectionLabel>{t("pay.paymentMethod")}</SectionLabel>
			<div className="seg-track seg-track-block">
				{(["external", "balance"] as const).map((method) => (
					<button key={method} type="button" className="seg-item" data-active={value === method} aria-pressed={value === method} onClick={() => onChange(method)}>
						{method === "external" ? t("pay.externalWalletMethod") : t("pay.gatoPagoBalanceMethod")}
					</button>
				))}
			</div>
		</div>
	);
}

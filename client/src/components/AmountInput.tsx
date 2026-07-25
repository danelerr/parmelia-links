// Amount entry that works on every mobile keyboard. type="number" breaks on
// iOS in Spanish: the decimal keyboard only offers a comma, which the field
// silently rejects, so users can't type decimals at all. This uses type="text"
// + inputMode="decimal", normalizes the comma to a dot, filters out anything
// that isn't a digit, and allows a single decimal separator. Styling stays at
// the call site via className, so each screen looks exactly as before.

import type { InputHTMLAttributes } from "react";

type AmountInputProps = Omit<
	InputHTMLAttributes<HTMLInputElement>,
	"type" | "inputMode" | "autoComplete" | "value" | "onChange"
> & {
	value: string;
	onChange: (value: string) => void;
};

/** Keep digits and one dot: "1,23" -> "1.23", "1.2.3" -> "1.23", "12a" -> "12". */
function sanitizeAmount(raw: string): string {
	const normalized = raw.replace(/,/g, ".").replace(/[^0-9.]/g, "");
	const firstDot = normalized.indexOf(".");
	if (firstDot === -1) return normalized;
	return (
		normalized.slice(0, firstDot + 1) + normalized.slice(firstDot + 1).replace(/\./g, "")
	);
}

export default function AmountInput({ value, onChange, ...props }: AmountInputProps) {
	return (
		<input
			{...props}
			type="text"
			inputMode="decimal"
			autoComplete="off"
			value={value}
			onChange={(e) => onChange(sanitizeAmount(e.target.value))}
		/>
	);
}

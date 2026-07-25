// Shared formatters so amounts and dates read consistently ("es" locale) across
// the whole dashboard, instead of each page rolling its own toLocaleString.

const AMOUNT = new Intl.NumberFormat("es", { maximumFractionDigits: 6 });
const DATE = new Intl.DateTimeFormat("es", { day: "numeric", month: "short", year: "numeric" });
const DATE_TIME = new Intl.DateTimeFormat("es", {
	day: "numeric",
	month: "short",
	year: "numeric",
	hour: "2-digit",
	minute: "2-digit",
});

export function formatAmount(value: string | number): string {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? AMOUNT.format(n) : String(value);
}

export function formatDate(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "—" : DATE.format(d);
}

export function formatDateTime(iso: string | null | undefined): string {
	if (!iso) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "—" : DATE_TIME.format(d);
}

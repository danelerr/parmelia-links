// Display formatting for token amounts and dates - always in the ACTIVE app
// language (i18n.resolvedLanguage), so es/en users see their own separators
// and month names instead of hardcoded "en-US"/"es" output.
//
// Amounts: high-decimal assets (ETH up to 18, WBTC up to 8) can produce
// strings like "0.000123456789012345" that overflow a receipt card or a
// history row. formatAmount caps the SHOWN fraction digits, trims trailing
// zeros, and flags dust that rounds to zero. Full precision is always
// available on-chain / via the explorer link in the receipt.

import i18n from "./i18n";

// Stablecoins are always shown with exactly 2 decimals (money-like).
const STABLE = new Set(["USDC", "USDT", "DAI", "USDC.e"]);
// Max fraction digits shown for volatile assets (ETH, WBTC, …).
const MAX_VOLATILE_DECIMALS = 6;

function activeLocale(): string {
	return i18n.resolvedLanguage || i18n.language || "es";
}

/** Locale-aware number formatting with bounded fraction digits. */
export function formatNumber(
	value: string | number | undefined | null,
	maximumFractionDigits = MAX_VOLATILE_DECIMALS,
	minimumFractionDigits?: number,
): string {
	const n = typeof value === "number" ? value : Number(value ?? "0");
	if (!Number.isFinite(n)) return String(value ?? "0");
	return n.toLocaleString(activeLocale(), { maximumFractionDigits, minimumFractionDigits });
}

/**
 * Format a token amount for display. `value` is a decimal string (as stored) or
 * a number; `currency` selects the precision. Never returns more than a bounded
 * width, so it won't overflow its container.
 */
export function formatAmount(value: string | number | undefined | null, currency: string): string {
	const n = typeof value === "number" ? value : Number(value ?? "0");
	if (!Number.isFinite(n)) return String(value ?? "0");

	if (STABLE.has(currency)) {
		return formatNumber(n, 2, 2);
	}

	// Positive dust that rounds to "0" at the cap → show a clear floor instead of
	// a misleading "0" (e.g. 0.0000001 ETH).
	if (n > 0 && Math.round(n * 10 ** MAX_VOLATILE_DECIMALS) === 0) return "<0.000001";
	return formatNumber(n, MAX_VOLATILE_DECIMALS);
}

/** Locale-aware date, e.g. "12 de junio de 2026" / "June 12, 2026". */
export function formatDate(
	value: string | number | Date,
	options: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" },
): string {
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleDateString(activeLocale(), options);
}

/** Locale-aware time, e.g. "14:30" / "2:30 PM". */
export function formatTime(value: string | number | Date): string {
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleTimeString(activeLocale(), { hour: "2-digit", minute: "2-digit" });
}

/** Locale-aware date + time, e.g. "12 de junio de 2026, 14:30". */
export function formatDateTime(value: string | number | Date): string {
	const d = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(d.getTime())) return "";
	return d.toLocaleString(activeLocale(), {
		day: "numeric",
		month: "long",
		year: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

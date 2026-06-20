// Display formatting for token amounts. High-decimal assets (ETH up to 18,
// WBTC up to 8) can produce strings like "0.000123456789012345" that overflow a
// receipt card or a history row. This caps the SHOWN fraction digits, trims
// trailing zeros, and flags dust that rounds to zero. Full precision is always
// available on-chain / via the explorer link in the receipt.

// Stablecoins are always shown with exactly 2 decimals (money-like).
const STABLE = new Set(["USDC", "USDT", "DAI", "USDC.e"]);
// Max fraction digits shown for volatile assets (ETH, WBTC, …).
const MAX_VOLATILE_DECIMALS = 6;

/**
 * Format a token amount for display. `value` is a decimal string (as stored) or
 * a number; `currency` selects the precision. Never returns more than a bounded
 * width, so it won't overflow its container.
 */
export function formatAmount(value: string | number | undefined | null, currency: string): string {
	const n = typeof value === "number" ? value : Number(value ?? "0");
	if (!Number.isFinite(n)) return String(value ?? "0");

	if (STABLE.has(currency)) {
		return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	}

	const formatted = n.toLocaleString("en-US", { maximumFractionDigits: MAX_VOLATILE_DECIMALS });
	// Positive dust that rounds to "0" at the cap → show a clear floor instead of
	// a misleading "0" (e.g. 0.0000001 ETH).
	if (n > 0 && Number(formatted.replace(/,/g, "")) === 0) return "<0.000001";
	return formatted;
}

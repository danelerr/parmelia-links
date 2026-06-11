// Pure input-validation/normalization helpers shared by the payment and link routes.
// Kept free of Cloudflare/viem bindings so they are trivially unit-testable.

/** Pseudo link ids the client uses for non-stored payments (not real DB rows). */
export const CLIENT_SIDE_PAYMENT_IDS = new Set(["direct", "username", "manual"]);

/** Strict positive amount: returns the trimmed string or null if not a finite > 0 number. */
export function normalizePositiveAmount(amount: unknown): string | null {
	if (amount === undefined || amount === null) return null;
	const normalized = String(amount).trim();
	if (!normalized) return null;
	const numeric = Number(normalized);
	if (!Number.isFinite(numeric) || numeric <= 0) return null;
	return normalized;
}

/** Link amount: allows empty/0 (open amount), rejects non-numbers and negatives. */
export function normalizeLinkAmount(amount: unknown): { value?: string; error?: string } {
	if (amount === undefined || amount === null) return { value: "0" };

	const normalized = String(amount).trim();
	if (!normalized) return { value: "0" };

	const numeric = Number(normalized);
	if (!Number.isFinite(numeric)) {
		return { error: "Amount must be a valid number or empty" };
	}
	if (numeric < 0) {
		return { error: "Amount cannot be negative" };
	}

	return { value: numeric === 0 ? "0" : normalized };
}

/**
 * Currency must be one of the chain's whitelisted symbols. Empty/nullish
 * returns `fallback` (pass "USDC" for the link flow, null for strict flows).
 */
export function normalizeCurrency(
	currency: unknown,
	allowed: readonly string[],
	fallback: string | null = null,
): string | null {
	if (currency === undefined || currency === null || String(currency).trim() === "") {
		return fallback;
	}
	const normalized = String(currency).trim().toUpperCase();
	return allowed.includes(normalized) ? normalized : null;
}

export function normalizeWalletAddress(wallet: unknown): `0x${string}` | null {
	if (typeof wallet !== "string") return null;
	const normalized = wallet.trim();
	if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) return null;
	return normalized as `0x${string}`;
}

export function normalizeReference(reference: unknown): string {
	return typeof reference === "string" ? reference.trim() : "";
}

export function isStoredPaymentLink(linkId: unknown): linkId is string {
	return (
		typeof linkId === "string" &&
		linkId.length > 0 &&
		!CLIENT_SIDE_PAYMENT_IDS.has(linkId)
	);
}

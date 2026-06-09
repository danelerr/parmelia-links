import { describe, expect, it } from "vitest";
import {
	isStoredPaymentLink,
	normalizeCurrency,
	normalizeLinkAmount,
	normalizePositiveAmount,
	normalizeReference,
	normalizeWalletAddress,
} from "../src/services/validation";

describe("normalizePositiveAmount", () => {
	it("accepts positive numbers and trims", () => {
		expect(normalizePositiveAmount("10")).toBe("10");
		expect(normalizePositiveAmount("  5 ")).toBe("5");
		expect(normalizePositiveAmount("1.5")).toBe("1.5");
		expect(normalizePositiveAmount(2)).toBe("2");
	});

	it("rejects zero, negatives, empty and non-numbers", () => {
		expect(normalizePositiveAmount("0")).toBeNull();
		expect(normalizePositiveAmount("-1")).toBeNull();
		expect(normalizePositiveAmount("")).toBeNull();
		expect(normalizePositiveAmount("abc")).toBeNull();
		expect(normalizePositiveAmount(undefined)).toBeNull();
		expect(normalizePositiveAmount(null)).toBeNull();
	});
});

describe("normalizeLinkAmount", () => {
	it("treats empty/nullish/zero as an open (0) amount", () => {
		expect(normalizeLinkAmount(undefined)).toEqual({ value: "0" });
		expect(normalizeLinkAmount(null)).toEqual({ value: "0" });
		expect(normalizeLinkAmount("")).toEqual({ value: "0" });
		expect(normalizeLinkAmount("0")).toEqual({ value: "0" });
	});

	it("keeps valid positive amounts", () => {
		expect(normalizeLinkAmount("10")).toEqual({ value: "10" });
	});

	it("rejects negatives and non-numbers", () => {
		expect(normalizeLinkAmount("-1").error).toBeTruthy();
		expect(normalizeLinkAmount("abc").error).toBeTruthy();
	});
});

describe("normalizeCurrency", () => {
	it("normalizes case and accepts only USDC/ETH", () => {
		expect(normalizeCurrency("usdc")).toBe("USDC");
		expect(normalizeCurrency("ETH")).toBe("ETH");
		expect(normalizeCurrency(" eth ")).toBe("ETH");
		expect(normalizeCurrency("btc")).toBeNull();
	});

	it("applies the fallback for empty/nullish input", () => {
		expect(normalizeCurrency("")).toBeNull();
		expect(normalizeCurrency(undefined)).toBeNull();
		expect(normalizeCurrency("", "USDC")).toBe("USDC");
		expect(normalizeCurrency(undefined, "USDC")).toBe("USDC");
	});
});

describe("normalizeWalletAddress", () => {
	it("accepts a 40-hex address and trims", () => {
		const addr = "0x" + "a".repeat(40);
		expect(normalizeWalletAddress(addr)).toBe(addr);
		expect(normalizeWalletAddress(` ${addr} `)).toBe(addr);
	});

	it("rejects malformed addresses", () => {
		expect(normalizeWalletAddress("0x123")).toBeNull();
		expect(normalizeWalletAddress("a".repeat(40))).toBeNull();
		expect(normalizeWalletAddress(123)).toBeNull();
		expect(normalizeWalletAddress(null)).toBeNull();
	});
});

describe("normalizeReference", () => {
	it("trims strings and coerces non-strings to empty", () => {
		expect(normalizeReference("  hola ")).toBe("hola");
		expect(normalizeReference(123)).toBe("");
		expect(normalizeReference(undefined)).toBe("");
	});
});

describe("isStoredPaymentLink", () => {
	it("treats real ids as stored links", () => {
		expect(isStoredPaymentLink("abc-123")).toBe(true);
	});

	it("excludes client-side pseudo ids and invalid values", () => {
		expect(isStoredPaymentLink("manual")).toBe(false);
		expect(isStoredPaymentLink("direct")).toBe(false);
		expect(isStoredPaymentLink("username")).toBe(false);
		expect(isStoredPaymentLink("")).toBe(false);
		expect(isStoredPaymentLink(123)).toBe(false);
		expect(isStoredPaymentLink(undefined)).toBe(false);
	});
});

import type { Address, CheckoutResume, Hex } from "./types";

const PREFIX = "gatopago.checkout.v2";
const LEGACY_PREFIX = "gatopago.checkout.v1";

function key(linkId: string): string {
	return `${PREFIX}:${linkId}`;
}

function isAddress(value: unknown): value is Address {
	return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/u.test(value);
}

function isHashOrNull(value: unknown): value is Hex | null {
	return value === null || (typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value));
}

export function loadCheckoutResume(linkId: string): CheckoutResume | null {
	try {
		localStorage.removeItem(`${LEGACY_PREFIX}:${linkId}`);
		const raw = sessionStorage.getItem(key(linkId));
		if (!raw) return null;
		const value = JSON.parse(raw) as Partial<CheckoutResume>;
		if (
			value.version !== 2 ||
			value.linkId !== linkId ||
			typeof value.idempotencyKey !== "string" ||
			typeof value.attemptCapability !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/u.test(value.attemptCapability) ||
			!isAddress(value.payer) ||
			typeof value.chainId !== "number" ||
			!Number.isSafeInteger(value.chainId) ||
			(value.attemptId !== null && typeof value.attemptId !== "string") ||
			!isHashOrNull(value.sourceTxHash) ||
			typeof value.updatedAt !== "string"
		) {
			sessionStorage.removeItem(key(linkId));
			return null;
		}
		return value as CheckoutResume;
	} catch {
		return null;
	}
}

function newCapability(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const binary = Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function beginCheckoutResume(linkId: string, payer: Address, chainId: number): CheckoutResume {
	const existing = loadCheckoutResume(linkId);
	if (existing && existing.payer.toLowerCase() === payer.toLowerCase() && existing.chainId === chainId) {
		return existing;
	}
	const resume: CheckoutResume = {
		version: 2,
		linkId,
		idempotencyKey: crypto.randomUUID(),
		attemptCapability: newCapability(),
		payer,
		chainId,
		attemptId: null,
		sourceTxHash: null,
		updatedAt: new Date().toISOString(),
	};
	sessionStorage.setItem(key(linkId), JSON.stringify(resume));
	return resume;
}

export function saveCheckoutResume(resume: CheckoutResume): CheckoutResume {
	const next = { ...resume, updatedAt: new Date().toISOString() };
	sessionStorage.setItem(key(resume.linkId), JSON.stringify(next));
	return next;
}

export function clearCheckoutResume(linkId: string): void {
	sessionStorage.removeItem(key(linkId));
	localStorage.removeItem(`${LEGACY_PREFIX}:${linkId}`);
}

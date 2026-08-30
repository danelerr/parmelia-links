import type { Bindings } from "../env";

const RP_ID_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export function validPasskeyRpId(value: string | undefined): boolean {
	if (!value) return false;
	const normalized = value.trim().toLowerCase();
	return normalized === "localhost" || (normalized.includes(".") && RP_ID_RE.test(normalized));
}

export function originMatchesPasskeyRpId(origin: string, rpId: string): boolean {
	try {
		const url = new URL(origin);
		return (
			url.origin === origin &&
			(url.hostname.toLowerCase() === rpId ||
				url.hostname.toLowerCase().endsWith(`.${rpId}`))
		);
	} catch {
		return false;
	}
}

export function configuredPasskeyOrigins(env: Bindings): string[] {
	const explicit = env.PASSKEY_ALLOWED_ORIGINS
		?.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	return explicit?.length ? [...new Set(explicit)] : [];
}

export function configuredPasskeyRpId(env: Bindings): string {
	const explicit = env.PASSKEY_RP_ID?.trim().toLowerCase();
	if (validPasskeyRpId(explicit)) return explicit!;
	throw new Error("PASSKEY_RP_ID is missing or invalid");
}

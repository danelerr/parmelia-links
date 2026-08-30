export type PasskeyProviderMetadata = {
	aaguid: string | null;
	providerName: string | null;
};

// Best-effort management labels only. AAGUID can be absent or manipulated
// without trusted attestation, so it must never authorize, deny, or rank a
// credential. Public keys and on-chain signer state remain canonical.
const PROVIDERS_BY_AAGUID: Readonly<Record<string, string>> = {
	"08987058-cadc-4b81-b6e1-30de50dcbe96": "Windows Hello",
	"531126d6-e717-415c-9320-3d9aa6981239": "Dashlane",
	"6028b017-b1d4-4c02-b4b3-afcdafc96bb2": "Windows Hello",
	"9ddd1817-af5a-4672-a2b9-3e3dd95000a9": "Windows Hello",
	"bada5566-a7aa-401f-bd96-45619a55120d": "1Password",
	"d548826e-79b4-db40-a3d8-11116f7e8349": "Bitwarden",
	"dd4ec289-e01d-41c9-bb89-70fa845d4bf2": "iCloud Keychain (Managed)",
	"ea9b8d66-4d01-1d21-3ce4-b6b48cb575d4": "Google Password Manager",
	"fbfc3007-154e-4ecc-8c0b-6e020557d7bd": "Apple Passwords",
	"0ea242b4-43c4-4a1b-8b17-dd6d0b6baec6": "Keeper",
	"50726f74-6f6e-5061-7373-50726f746f6e": "Proton Pass",
	"53414d53-554e-4700-0000-000000000000": "Samsung Pass",
	"b84e4048-15dc-4dd0-8640-f4f60813c8af": "NordPass",
	"f3809540-7f14-49c1-a8b3-8f813b225541": "Enpass",
};

function normalizeAaguid(value: string | undefined | null): string | null {
	const normalized = value?.trim().toLowerCase() ?? "";
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(normalized)) {
		return null;
	}
	return normalized === "00000000-0000-0000-0000-000000000000" ? null : normalized;
}

export function passkeyProviderMetadata(aaguid: string | undefined | null): PasskeyProviderMetadata {
	const normalized = normalizeAaguid(aaguid);
	return {
		aaguid: normalized,
		providerName: normalized ? PROVIDERS_BY_AAGUID[normalized] ?? null : null,
	};
}

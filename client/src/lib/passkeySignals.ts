type WebAuthnSignalApi = {
	signalUnknownCredential?: (options: { rpId: string; credentialId: string }) => Promise<void>;
	signalAllAcceptedCredentials?: (options: {
		rpId: string;
		userId: string;
		allAcceptedCredentialIds: string[];
	}) => Promise<void>;
	signalCurrentUserDetails?: (options: {
		rpId: string;
		userId: string;
		name: string;
		displayName: string;
	}) => Promise<void>;
};

function signalApi(): WebAuthnSignalApi | null {
	if (typeof PublicKeyCredential === "undefined") return null;
	return PublicKeyCredential as unknown as WebAuthnSignalApi;
}

function utf8Base64url(value: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(value)) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** Best effort only: unsupported browsers and manager failures never block UX. */
export async function signalCurrentPasskeyUser(input: {
	rpId: string;
	uid: string;
	name: string;
	displayName: string;
}): Promise<void> {
	const api = signalApi();
	if (!api?.signalCurrentUserDetails) return;
	await api.signalCurrentUserDetails({
		rpId: input.rpId,
		userId: utf8Base64url(input.uid),
		name: input.name,
		displayName: input.displayName,
	}).catch(() => undefined);
}

/**
 * Call only when the server proved its D1 credential inventory exactly matches
 * every active on-chain signer. Omitting a valid id may hide that credential in
 * a password manager, so an incomplete list must never reach this API.
 */
export async function signalCompletePasskeyInventory(input: {
	rpId: string;
	uid: string;
	credentialIds: string[];
	inventoryComplete: boolean;
}): Promise<void> {
	if (!input.inventoryComplete) return;
	const api = signalApi();
	if (!api?.signalAllAcceptedCredentials) return;
	await api.signalAllAcceptedCredentials({
		rpId: input.rpId,
		userId: utf8Base64url(input.uid),
		allAcceptedCredentialIds: [...new Set(input.credentialIds)],
	}).catch(() => undefined);
}

export async function signalRemovedPasskey(rpId: string, credentialId: string): Promise<void> {
	const api = signalApi();
	if (!api?.signalUnknownCredential) return;
	await api.signalUnknownCredential({ rpId, credentialId }).catch(() => undefined);
}

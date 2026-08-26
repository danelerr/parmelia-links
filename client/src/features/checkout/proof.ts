import type { Address, Eip1193Provider, Hex } from "./types";

export async function hashCheckoutCapability(capability: string): Promise<Hex> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability));
	return `0x${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function signCheckoutPayerProof(input: {
	provider: Eip1193Provider;
	payer: Address;
	message: string;
}): Promise<Hex> {
	const signature = await input.provider.request({
		method: "personal_sign",
		params: [input.message, input.payer],
	});
	if (typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/u.test(signature)) {
		throw new Error("INVALID_PAYER_PROOF_SIGNATURE");
	}
	return signature as Hex;
}

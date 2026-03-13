// WebAuthn helpers for P256 passkey creation and signing

function bufferToBase64url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let str = "";
	for (const b of bytes) str += String.fromCharCode(b);
	return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBuffer(base64url: string): ArrayBuffer {
	const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

function bytesToHex(bytes: Uint8Array): string {
	return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Create a new P256 passkey. Returns the credentialId and public key (qx, qy). */
export async function createPasskey(username: string): Promise<{
	credentialId: string;
	qx: string;
	qy: string;
}> {
	const challenge = crypto.getRandomValues(new Uint8Array(32));

	const credential = (await navigator.credentials.create({
		publicKey: {
			rp: { name: "Parmelia", id: window.location.hostname },
			user: {
				id: new TextEncoder().encode(username),
				name: username,
				displayName: username,
			},
			challenge,
			pubKeyCredParams: [{ alg: -7, type: "public-key" }], // ES256 = P256
			authenticatorSelection: {
				authenticatorAttachment: "platform",
				residentKey: "required",
				userVerification: "required",
			},
			attestation: "none",
			timeout: 60000,
		},
	})) as PublicKeyCredential | null;

	if (!credential) throw new Error("No se pudo crear la credencial");

	const attestation = credential.response as AuthenticatorAttestationResponse;

	// Extract the P256 public key from the COSE key in attestationObject
	const { qx, qy } = extractP256PublicKey(attestation);

	return {
		credentialId: bufferToBase64url(credential.rawId),
		qx: "0x" + qx,
		qy: "0x" + qy,
	};
}

/** Extract P256 public key (qx, qy) from AuthenticatorAttestationResponse */
function extractP256PublicKey(attestation: AuthenticatorAttestationResponse): { qx: string; qy: string } {
	// getPublicKey() returns the SubjectPublicKeyInfo (SPKI) DER-encoded key
	const spkiDer = attestation.getPublicKey();
	if (!spkiDer) throw new Error("No se pudo obtener la clave publica");

	const spki = new Uint8Array(spkiDer);
	// P256 SPKI: 26 bytes header + 65 bytes uncompressed point (0x04 || x || y)
	const uncompressedOffset = spki.length - 65;
	if (spki[uncompressedOffset] !== 0x04) {
		throw new Error("Formato de clave publica inesperado");
	}
	const x = spki.slice(uncompressedOffset + 1, uncompressedOffset + 33);
	const y = spki.slice(uncompressedOffset + 33, uncompressedOffset + 65);
	return { qx: bytesToHex(x), qy: bytesToHex(y) };
}

async function requestAssertion(
	challenge: Uint8Array,
	credentialId?: string | null,
): Promise<PublicKeyCredential | null> {
	const publicKey: PublicKeyCredentialRequestOptions = {
		challenge: challenge.buffer as ArrayBuffer,
		userVerification: "required",
		timeout: 60000,
	};

	if (credentialId) {
		publicKey.allowCredentials = [
			{
				id: base64urlToBuffer(credentialId),
				type: "public-key",
				transports: ["internal", "hybrid"],
			},
		];
	}

	return (await navigator.credentials.get({
		publicKey,
	})) as PublicKeyCredential | null;
}

/**
 * Sign a challenge (userOpHash) with a passkey.
 *
 * If we have a stored credentialId, use it first so the browser does not offer
 * unrelated synced passkeys from the same RP. Discoverable credentials are kept
 * only for accounts that do not have a stored hint yet.
 */
export async function signWithPasskey(
	challenge: Uint8Array,
	credentialId?: string | null,
): Promise<{
	authenticatorData: string;
	clientDataJSON: string;
	r: string;
	s: string;
	credentialId: string;
}> {
	let assertion: PublicKeyCredential | null = null;
	let requestError: unknown = null;

	try {
		assertion = credentialId
			? await requestAssertion(challenge, credentialId)
			: await requestAssertion(challenge);
	} catch (error) {
		requestError = error;
	}

	if (!assertion) {
		if (requestError instanceof Error) {
			throw requestError;
		}
		throw new Error("Firma cancelada");
	}

	const response = assertion.response as AuthenticatorAssertionResponse;
	const authenticatorData = new Uint8Array(response.authenticatorData);
	const clientDataJSON = new TextDecoder().decode(response.clientDataJSON);
	const signature = new Uint8Array(response.signature);

	// Parse DER-encoded P256 signature to (r, s)
	const { r, s } = parseDERSignature(signature);

	return {
		authenticatorData: "0x" + bytesToHex(authenticatorData),
		clientDataJSON,
		r: "0x" + r.padStart(64, "0"),
		s: "0x" + s.padStart(64, "0"),
		credentialId: bufferToBase64url(assertion.rawId),
	};
}

/** Parse a DER-encoded ECDSA signature into r and s hex strings */
function parseDERSignature(der: Uint8Array): { r: string; s: string } {
	// DER: 0x30 <len> 0x02 <r_len> <r> 0x02 <s_len> <s>
	if (der[0] !== 0x30) throw new Error("Invalid DER signature");
	let offset = 2;

	// Read r
	if (der[offset] !== 0x02) throw new Error("Invalid DER r tag");
	offset++;
	const rLen = der[offset];
	offset++;
	let rBytes = der.slice(offset, offset + rLen);
	offset += rLen;
	if (rBytes[0] === 0x00 && rBytes.length > 32) rBytes = rBytes.slice(1);
	const r = bytesToHex(rBytes);

	// Read s
	if (der[offset] !== 0x02) throw new Error("Invalid DER s tag");
	offset++;
	const sLen = der[offset];
	offset++;
	let sBytes = der.slice(offset, offset + sLen);
	if (sBytes[0] === 0x00 && sBytes.length > 32) sBytes = sBytes.slice(1);
	const s = bytesToHex(sBytes);

	return { r, s };
}


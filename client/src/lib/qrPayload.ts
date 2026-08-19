type EvmQrSource = "address" | "eip681" | "caip10";

export type ParsedQrPayload =
	| { kind: "gatopago"; target: string }
	| {
			kind: "evm-wallet";
			address: `0x${string}`;
			chainId: number | null;
			source: EvmQrSource;
	  };

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const CAIP_10_RE = /^eip155:(\d+):(0x[a-fA-F0-9]{40})$/i;

function positiveChainId(raw: string | undefined): number | null {
	if (!raw) return null;
	const chainId = Number(raw);
	return Number.isSafeInteger(chainId) && chainId > 0 ? chainId : null;
}

function trustedGatoPagoHost(hostname: string, appUrl: string): boolean {
	const normalized = hostname.toLowerCase();
	// Pre-cutover hosts stay trusted so existing printed QR codes keep working.
	const trusted = new Set<string>(["parmelia.me", "app.parmelia.me"]);
	try {
		trusted.add(new URL(appUrl).hostname.toLowerCase());
	} catch {
		// An invalid build-time URL must not broaden the trusted-host list.
	}
	return trusted.has(normalized) || normalized.endsWith(".parmelia.me");
}

function parseEip681(value: string): ParsedQrPayload | null {
	const normalized = value.replace(/^ethereum:\/\//i, "ethereum:");
	const match = normalized.match(
		/^ethereum:(?:pay-)?([^@/?]+)(?:@(\d+))?(?:\/([^?]+))?(?:\?(.*))?$/i,
	);
	if (!match) return null;

	const [, target, rawChainId, rawFunction, rawQuery] = match;
	const chainId = positiveChainId(rawChainId);
	if (rawChainId && chainId === null) return null;

	if (!rawFunction && EVM_ADDRESS_RE.test(target)) {
		return {
			kind: "evm-wallet",
			address: target as `0x${string}`,
			chainId,
			source: "eip681",
		};
	}

	// ERC-681 token-payment requests target the token contract and put the
	// beneficiary in `address`. We deliberately ignore amount/gas parameters:
	// untrusted QR data is only allowed to prefill a human-reviewed recipient.
	if (rawFunction?.toLowerCase() === "transfer" && rawQuery) {
		const beneficiary = new URLSearchParams(rawQuery).get("address");
		if (beneficiary && EVM_ADDRESS_RE.test(beneficiary)) {
			return {
				kind: "evm-wallet",
				address: beneficiary as `0x${string}`,
				chainId,
				source: "eip681",
			};
		}
	}

	return null;
}

export function parseQrPayload(
	rawValue: string,
	context: { origin: string; appUrl: string },
): ParsedQrPayload | null {
	const value = rawValue.trim();
	if (!value) return null;

	if (value.startsWith("/") && !value.startsWith("//")) {
		return { kind: "gatopago", target: value };
	}

	if (EVM_ADDRESS_RE.test(value)) {
		return {
			kind: "evm-wallet",
			address: value as `0x${string}`,
			chainId: null,
			source: "address",
		};
	}

	const caip10 = value.match(CAIP_10_RE);
	if (caip10) {
		const chainId = positiveChainId(caip10[1]);
		if (!chainId) return null;
		return {
			kind: "evm-wallet",
			address: caip10[2] as `0x${string}`,
			chainId,
			source: "caip10",
		};
	}

	const eip681 = parseEip681(value);
	if (eip681) return eip681;

	try {
		const parsed = new URL(value, context.origin);
		if (
			parsed.origin === context.origin ||
			trustedGatoPagoHost(parsed.hostname, context.appUrl)
		) {
			return {
				kind: "gatopago",
				target: parsed.pathname + parsed.search + parsed.hash,
			};
		}
	} catch {
		return null;
	}

	return null;
}

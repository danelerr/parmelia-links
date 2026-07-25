// Flow B: build the Parmelia-signed authorization a payer needs to call
// PaymentRouter.payInvoice from any external wallet. The signed digest MUST match
// ParmeliaPaymentRouter.invoiceDigest exactly, or the on-chain ECDSA.recover fails.

import { privateKeyToAccount } from "viem/accounts";
import {
	encodeAbiParameters,
	keccak256,
	parseAbiParameters,
	parseUnits,
	toBytes,
	type Hex,
} from "viem";
import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { getRouterSignerKey } from "./keys";
import type { PaymentIntentRecord } from "./storage";

const ROUTER_AUTH_WINDOW_SECONDS = 3600;
const MAX_FEE_BPS = 100n; // mirrors the contract's hard cap
const ZERO = "0x0000000000000000000000000000000000000000";

function normalizeKey(key: string): Hex {
	return (key.startsWith("0x") ? key : `0x${key}`) as Hex;
}

/** Deterministic bytes32 invoiceId for an intent (stored as onchain_id). */
export function intentToInvoiceId(id: string): Hex {
	return keccak256(toBytes(id));
}

export function isRouterConfigured(env: Bindings): boolean {
	const r = getNetworkConfig(env.CHAIN_KEY).contracts.paymentRouter;
	return !!r && r !== ZERO;
}

export type RouterAuthorization = {
	router: `0x${string}`;
	chainId: number;
	invoiceId: Hex;
	token: `0x${string}`;
	amount: string; // atomic units
	merchant: `0x${string}`;
	feeBps: number;
	deadline: number;
	signature: Hex;
	call: { function: string; args: string };
	/**
	 * Alternative one-tx call: pay with an EIP-2612 permit (no prior approve).
	 * Only present when the DEPLOYED router supports it (paymentRouterHasPermit
	 * in shared/networks.ts) — the source gained payInvoiceWithPermit after the
	 * current testnet router was deployed, so advertising it unconditionally
	 * would point integrators at a selector the contract doesn't have.
	 */
	callWithPermit?: { function: string; args: string };
};

export class RouterError extends Error {}

export function routerAuthorizationDeadline(intent: Pick<PaymentIntentRecord, "expiresAt">, nowSeconds: number): number {
	const windowDeadline = nowSeconds + ROUTER_AUTH_WINDOW_SECONDS;
	if (!intent.expiresAt) return windowDeadline;
	const intentDeadline = Math.floor(new Date(intent.expiresAt).getTime() / 1000);
	if (!Number.isFinite(intentDeadline) || intentDeadline <= nowSeconds) {
		throw new RouterError("Payment intent is expired.");
	}
	return Math.min(windowDeadline, intentDeadline);
}

export async function buildRouterAuthorization(
	env: Bindings,
	intent: PaymentIntentRecord,
	merchant: `0x${string}`,
): Promise<RouterAuthorization> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const router = network.contracts.paymentRouter;
	if (!router || router === ZERO) {
		throw new RouterError("PaymentRouter is not deployed on this network.");
	}
	// On-chain open payments settle in USDC for now.
	if (intent.currency !== "USDC") {
		throw new RouterError("On-chain pay (Flow B) currently supports USDC only.");
	}

	const token = network.contracts.usdc;
	const amount = parseUnits(intent.amount, network.contracts.usdcDecimals);

	let feeBps = BigInt(env.PARMELIA_PAYMENT_FEE_BPS || "0");
	if (feeBps < 0n) feeBps = 0n;
	if (feeBps > MAX_FEE_BPS) feeBps = MAX_FEE_BPS;

	const invoiceId = (intent.onchainId as Hex) || intentToInvoiceId(intent.id);
	const deadline = BigInt(routerAuthorizationDeadline(intent, Math.floor(Date.now() / 1000)));

	// Must match ParmeliaPaymentRouter.invoiceDigest(...) byte-for-byte.
	const digest = keccak256(
		encodeAbiParameters(
			parseAbiParameters("uint256, address, bytes32, address, uint256, address, uint256, uint256"),
			[BigInt(network.chainId), router, invoiceId, token, amount, merchant, feeBps, deadline],
		),
	);

	// Dedicated invoice-authorization key; testnet-only fallback (see services/keys.ts).
	const signerKey = getRouterSignerKey(env);
	if (!signerKey) throw new RouterError("No router signer key configured.");
	const signer = privateKeyToAccount(normalizeKey(signerKey));
	// signMessage({ raw }) applies the EIP-191 prefix === MessageHashUtils.toEthSignedMessageHash.
	const signature = await signer.signMessage({ message: { raw: digest } });

	const auth: RouterAuthorization = {
		router,
		chainId: network.chainId,
		invoiceId,
		token,
		amount: amount.toString(),
		merchant,
		feeBps: Number(feeBps),
		deadline: Number(deadline),
		signature,
		call: {
			function: "payInvoice(bytes32,address,uint256,address,uint256,uint256,bytes,bytes)",
			args: "invoiceId, token, amount, merchant, feeBps, deadline, signature, metadata(0x)",
		},
	};
	if (network.paymentRouterHasPermit) {
		auth.callWithPermit = {
			function:
				"payInvoiceWithPermit(bytes32,address,uint256,address,uint256,uint256,bytes,bytes,uint256,uint8,bytes32,bytes32)",
			args: "…same first 8 args…, permitDeadline, v, r, s — pay in ONE tx with an EIP-2612 permit signed by the payer (no separate approve). USDC supports permit.",
		};
	}
	return auth;
}

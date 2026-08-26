import { paymentsApiFetch } from "../../lib/api";
import type {
	Address,
	CheckoutAttempt,
	CheckoutQuote,
	CheckoutResponse,
} from "./types";

export function getCheckout(linkId: string): Promise<CheckoutResponse> {
	return paymentsApiFetch(`/checkout/${encodeURIComponent(linkId)}`);
}

export function createCheckoutQuote(input: {
	linkId: string;
	payer: Address;
	sourceChainId: number;
	attemptCapabilityHash: string;
	amount?: string;
	route?: "auto" | "fast" | "standard";
}): Promise<CheckoutQuote> {
	return paymentsApiFetch(`/checkout/${encodeURIComponent(input.linkId)}/quotes`, {
		body: {
			payer: input.payer,
			source_chain_id: input.sourceChainId,
			attempt_capability_hash: input.attemptCapabilityHash,
			route: input.route ?? "auto",
			...(input.amount ? { amount: input.amount } : {}),
		},
	});
}

export function createCheckoutAttempt(input: {
	linkId: string;
	quoteId: string;
	idempotencyKey: string;
	attemptCapability: string;
	payerProofSignature: string;
}): Promise<CheckoutAttempt> {
	return paymentsApiFetch(`/checkout/${encodeURIComponent(input.linkId)}/attempts`, {
		headers: { "Idempotency-Key": input.idempotencyKey,
			"X-GatoPago-Checkout-Capability": input.attemptCapability },
		body: { quote_id: input.quoteId, payer_proof_signature: input.payerProofSignature },
	});
}

export function registerCheckoutTransaction(input: {
	linkId: string;
	attemptId: string;
	attemptCapability: string;
	sourceTxHash: string;
}): Promise<CheckoutAttempt> {
	return paymentsApiFetch(
		`/checkout/${encodeURIComponent(input.linkId)}/attempts/${encodeURIComponent(input.attemptId)}/register`,
		{ headers: { "X-GatoPago-Checkout-Capability": input.attemptCapability },
			body: { source_tx_hash: input.sourceTxHash } },
	);
}

export function getCheckoutAttempt(linkId: string, attemptId: string,
	attemptCapability: string): Promise<CheckoutAttempt> {
	return paymentsApiFetch(
		`/checkout/${encodeURIComponent(linkId)}/attempts/${encodeURIComponent(attemptId)}`,
		{ headers: { "X-GatoPago-Checkout-Capability": attemptCapability } },
	);
}

export function cancelCheckoutAttempt(attemptId: string,
	attemptCapability: string): Promise<{ id: string; status: "canceled" }> {
	return paymentsApiFetch(`/checkout/attempts/${encodeURIComponent(attemptId)}/cancel`, {
		headers: { "X-GatoPago-Checkout-Capability": attemptCapability },
		body: {},
	});
}

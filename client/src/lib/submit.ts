// Shared /pay/submit client - one place that understands the payment lifecycle.
// The server answers one of two ways after signature validation:
//   202 {status:"pending", txHash} - accepted and broadcast; the reconciler
//       verifies and settles it. Poll GET /pay/status/:userOpHash to resolve.
//   409 PAYMENT_IN_PROGRESS - this exact op was already submitted (double tap
//       or retried request); the money is very likely moving.
// Both non-success shapes come back as {confirmed:false} so pages show a calm
// "in progress" state and poll, instead of a scary error for money in flight.

import { ApiError, apiFetch } from "./api";
import type { User } from "./firebase";

/** The signature bundle produced by signWithPasskey. */
export type PasskeyAssertion = {
	authenticatorData: string;
	clientDataJSON: string;
	r: string;
	s: string;
	credentialId: string;
	qx: string | null;
	qy: string | null;
};

export type SubmitOutcome = {
	/** true = settled on-chain; false = in flight (poll /pay/status/:userOpHash). */
	confirmed: boolean;
	txHash: string | null;
};

export async function submitUserOp(
	user: User,
	userOpHash: string,
	assertion: PasskeyAssertion,
): Promise<SubmitOutcome> {
	try {
		const res = await apiFetch<{ status?: string; txHash?: string | null }>("/pay/submit", {
			user,
			body: {
				userOpHash,
				authenticatorData: assertion.authenticatorData,
				clientDataJSON: assertion.clientDataJSON,
				r: assertion.r,
				s: assertion.s,
				credentialId: assertion.credentialId,
				qx: assertion.qx,
				qy: assertion.qy,
			},
		});
		return { confirmed: res.status === "success", txHash: res.txHash ?? null };
	} catch (err) {
		if (err instanceof ApiError && err.code === "PAYMENT_IN_PROGRESS") {
			return { confirmed: false, txHash: null };
		}
		throw err;
	}
}

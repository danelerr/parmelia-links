// Polls GET /pay/status/:userOpHash after a submit came back "in flight"
// (202 accepted broadcast, or 409 duplicate). The server reconciler
// cron runs every 2 minutes, so we poll for ~3 minutes and then hand off to
// the push notification - the payment settles server-side either way.

import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import type { User } from "../lib/firebase";

export type PaymentLifecycleStatus =
	| "prepared"
	| "submitting"
	| "submitted"
	| "confirmed"
	| "failed"
	| "unknown";

const POLL_MS = 5000;
const MAX_POLLS = 36;

/** Pass nulls to keep the hook idle when no submitted operation is being tracked. */
export function usePaymentStatus(user: User | null, userOpHash: string | null) {
	const [status, setStatus] = useState<PaymentLifecycleStatus | null>(null);
	const [txHash, setTxHash] = useState<string | null>(null);
	const [ended, setEnded] = useState(false);

	useEffect(() => {
		if (!user || !userOpHash) return;
		setStatus(null);
		setTxHash(null);
		setEnded(false);
		let polls = 0;
		let stopped = false;
		const timer = setInterval(async () => {
			if (stopped) return;
			polls++;
			try {
				const data = await apiFetch<{
					status: PaymentLifecycleStatus;
					txHash?: string | null;
				}>(`/pay/status/${userOpHash}`, { user });
				if (stopped) return;
				setStatus(data.status);
				if (data.txHash) setTxHash(data.txHash);
				if (data.status === "confirmed" || data.status === "failed") {
					stopped = true;
					clearInterval(timer);
					setEnded(true);
				}
			} catch {
				/* transient; keep polling until the cap */
			}
			if (polls >= MAX_POLLS && !stopped) {
				stopped = true;
				clearInterval(timer);
				setEnded(true);
			}
		}, POLL_MS);
		return () => {
			stopped = true;
			clearInterval(timer);
		};
	}, [user, userOpHash]);

	return { status, txHash, ended };
}

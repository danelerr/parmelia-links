// Polls GET /pay/status/:userOpHash after a submit came back "in flight"
// (202 accepted broadcast, or 409 duplicate). Submission wakes the durable
// server reconciler immediately; the client polls for ~3 minutes and then hands
// off to push notification - settlement continues server-side either way.

import { useEffect, useState } from "react";
import { apiFetch } from "../lib/api";
import type { User } from "../lib/firebase";

export type PaymentLifecycleStatus =
	| "prepared"
	| "submitting"
	| "submitted"
	| "included"
	| "confirmed"
	| "failed"
	| "unknown";

const POLL_MS = 3000;
const MAX_POLLS = 60;

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
		let timer: ReturnType<typeof setTimeout> | null = null;
		const poll = async () => {
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
				if (
					data.status === "included" ||
					data.status === "confirmed" ||
					data.status === "failed"
				) {
					stopped = true;
					setEnded(true);
				}
			} catch {
				/* transient; keep polling until the cap */
			}
			if (polls >= MAX_POLLS && !stopped) {
				stopped = true;
				setEnded(true);
			}
			if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
		};
		// Do not impose a full polling interval before the first receipt check.
		void poll();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}, [user, userOpHash]);

	return { status, txHash, ended };
}

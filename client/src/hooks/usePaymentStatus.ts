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

type PollState = {
	key: string | null;
	status: PaymentLifecycleStatus | null;
	txHash: string | null;
	ended: boolean;
};

const IDLE_STATE: PollState = {
	key: null,
	status: null,
	txHash: null,
	ended: false,
};

/** Pass nulls to keep the hook idle when no submitted operation is being tracked. */
export function usePaymentStatus(user: User | null, userOpHash: string | null) {
	const operationKey = user && userOpHash ? `${user.uid}:${userOpHash}` : null;
	const [pollState, setPollState] = useState<PollState>(IDLE_STATE);

	useEffect(() => {
		if (!user || !userOpHash || !operationKey) return;
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
				const terminal =
					data.status === "included" ||
					data.status === "confirmed" ||
					data.status === "failed";
				setPollState((current) => ({
					key: operationKey,
					status: data.status,
					txHash:
						data.txHash ??
						(current.key === operationKey ? current.txHash : null),
					ended: terminal,
				}));
				if (terminal) {
					stopped = true;
				}
			} catch {
				/* transient; keep polling until the cap */
			}
			if (polls >= MAX_POLLS && !stopped) {
				stopped = true;
				setPollState((current) =>
					current.key === operationKey
						? { ...current, ended: true }
						: { ...IDLE_STATE, key: operationKey, ended: true },
				);
			}
			if (!stopped) timer = setTimeout(() => void poll(), POLL_MS);
		};
		// Do not impose a full polling interval before the first receipt check.
		void poll();
		return () => {
			stopped = true;
			if (timer) clearTimeout(timer);
		};
	}, [operationKey, user, userOpHash]);

	const current = pollState.key === operationKey ? pollState : IDLE_STATE;
	return { status: current.status, txHash: current.txHash, ended: current.ended };
}

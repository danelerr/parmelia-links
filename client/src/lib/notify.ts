// Centralized notifications - the only place that talks to sileo for outcomes.
//
// Guarantees:
//   - the user NEVER sees raw technical text (hex blobs, stack-ish messages);
//   - cancelling a passkey prompt is a calm notice, not a red error;
//   - server requestIds are surfaced ("Ref: ...") so support can find the log;
//   - identical toasts within a short window are deduped (no double-tap spam).

import { sileo } from "sileo";
import { ApiError } from "./api";
import i18n from "./i18n";

let lastKey = "";
let lastAt = 0;
function deduped(key: string): boolean {
	const now = Date.now();
	if (key === lastKey && now - lastAt < 2500) return true;
	lastKey = key;
	lastAt = now;
	return false;
}

/** The user dismissed/timed out a passkey, share or login prompt - not a failure. */
export function isUserCancelled(err: unknown): boolean {
	if (!(err instanceof Error)) return false;
	if (err.name === "NotAllowedError" || err.name === "AbortError") return true;
	return /firma cancelada|cancel(led|ada)?|not allowed|timed out or was not allowed|popup.?closed/i.test(
		err.message,
	);
}

// Anything matching this is developer-speak, not user-speak.
const TECHNICAL_PATTERN =
	/0x[0-9a-fA-F]{6,}|userop|calldata|revert|execution|rpc|json|fetch|undefined|\[object|network ?error/i;

/** Reduce any thrown value to a short, human, Spanish message. */
export function humanizeError(
	err: unknown,
	fallback = i18n.t("notify.tryAgain"),
): { message: string; requestId?: string } {
	if (err instanceof ApiError) {
		// Server messages are already written for humans.
		return { message: err.message, requestId: err.requestId };
	}
	if (err instanceof Error && err.message) {
		const msg = err.message.trim();
		if (msg.length <= 140 && !TECHNICAL_PATTERN.test(msg)) {
			return { message: msg };
		}
	}
	return { message: fallback };
}

export function notifyError(err: unknown, title = i18n.t("notify.somethingWrong")) {
	if (isUserCancelled(err)) {
		notifyWarning(i18n.t("notify.cancelled"), i18n.t("notify.noChange"));
		return;
	}
	const { message, requestId } = humanizeError(err);
	const description = requestId
		? `${message} · Ref: ${String(requestId).slice(0, 8)}`
		: message;
	if (deduped(`e:${title}:${description}`)) return;
	sileo.error({ title, description });
}

export function notifySuccess(title: string, description?: string) {
	if (deduped(`s:${title}:${description ?? ""}`)) return;
	sileo.success({ title, description });
}

export function notifyWarning(title: string, description?: string) {
	if (deduped(`w:${title}:${description ?? ""}`)) return;
	sileo.warning({ title, description });
}

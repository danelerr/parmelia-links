// Centralized notifications for all client outcomes.
//
// Guarantees:
//   - the user NEVER sees raw technical text (hex blobs, stack-ish messages);
//   - cancelling a passkey prompt is a calm notice, not a red error;
//   - server requestIds are surfaced ("Ref: ...") so support can find the log;
//   - identical toasts within a short window are deduped (no double-tap spam).

import { ApiError } from "./api";
import i18n from "./i18n";
import { pushToast, updateToast, type ToastAction } from "./toastStore";

// How long each kind of toast stays on screen (ms). Confirmations leave quickly,
// errors linger so they can be read, and anything actionable stays long enough
// for the user to actually reach for the button.
const DURATION = {
	success: 3500,
	warning: 5000,
	error: 6500,
	actionable: 10000,
} as const;

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
	/0x[0-9a-fA-F]{6,}|userop|calldata|revert|execution|rpc|json|fetch|undefined|\[object|network ?error|firebase|auth\//i;

/** Reduce any thrown value to a short, human, Spanish message. */
export function humanizeError(
	err: unknown,
	fallback = i18n.t("notify.tryAgain"),
): { message: string; requestId?: string } {
	if (err instanceof ApiError) {
		// Prefer the stable error_code (localized to the active language); fall back
		// to the server's human message when there's no code or no matching key.
		if (err.code) {
			return { message: i18n.t(`err.${err.code}`, { defaultValue: err.message }), requestId: err.requestId };
		}
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

export function notifyError(
	err: unknown,
	title = i18n.t("notify.somethingWrong"),
	action?: ToastAction,
) {
	if (isUserCancelled(err)) {
		notifyWarning(i18n.t("notify.cancelled"), i18n.t("notify.noChange"));
		return;
	}
	const { message, requestId } = humanizeError(err);
	const description = requestId
		? `${message} · Ref: ${String(requestId).slice(0, 8)}`
		: message;
	if (deduped(`e:${title}:${description}`)) return;
	pushToast({
		kind: "error",
		title,
		description,
		action,
		duration: action ? DURATION.actionable : DURATION.error,
	});
}

export function notifySuccess(title: string, description?: string, action?: ToastAction) {
	if (deduped(`s:${title}:${description ?? ""}`)) return;
	pushToast({
		kind: "success",
		title,
		description,
		action,
		duration: action ? DURATION.actionable : DURATION.success,
	});
}

export function notifyWarning(title: string, description?: string, action?: ToastAction) {
	if (deduped(`w:${title}:${description ?? ""}`)) return;
	pushToast({
		kind: "warning",
		title,
		description,
		action,
		duration: action ? DURATION.actionable : DURATION.warning,
	});
}

/**
 * Drive a single toast through loading -> success/error for a background task
 * that has no full-screen overlay of its own (faucet claim, enabling push,
 * saving a username, adding a contact). Pay and swap keep their own overlays.
 * Returns the original promise so callers can still await the result.
 */
export function notifyPromise<T>(
	promise: Promise<T>,
	messages: {
		loading: string;
		success: string | ((value: T) => string);
		error?: string;
	},
): Promise<T> {
	const toastId = pushToast({ kind: "loading", title: messages.loading, duration: null });
	void promise.then(
		(value) => {
			updateToast(toastId, {
				kind: "success",
				title: typeof messages.success === "function" ? messages.success(value) : messages.success,
				duration: DURATION.success,
			});
		},
		(err: unknown) => {
			if (isUserCancelled(err)) {
				updateToast(toastId, {
					kind: "warning",
					title: i18n.t("notify.cancelled"),
					description: i18n.t("notify.noChange"),
					duration: DURATION.warning,
				});
				return;
			}
			const { message, requestId } = humanizeError(err);
			updateToast(toastId, {
				kind: "error",
				title: messages.error ?? i18n.t("notify.somethingWrong"),
				description: requestId
					? `${message} · Ref: ${String(requestId).slice(0, 8)}`
					: message,
				duration: DURATION.error,
			});
		},
	);
	return promise;
}

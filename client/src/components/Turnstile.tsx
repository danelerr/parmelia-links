// Cloudflare Turnstile widget. A failed or expired challenge is a blocking
// state, never the empty-string development sentinel.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TurnstileState } from "./turnstileState";

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const SCRIPT_ID = "gatopago-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SCRIPT_LOAD_TIMEOUT_MS = 10_000;
const CHALLENGE_TIMEOUT_MS = 15_000;

export type TurnstileAction = "email_login" | "account_create" | "test_funds";

type TurnstileApi = {
	render: (
		el: HTMLElement,
		opts: {
			sitekey: string;
			callback: (token: string) => void;
			"expired-callback"?: () => void;
			"error-callback"?: () => void;
			"timeout-callback"?: () => void;
			"unsupported-callback"?: () => void;
			action: TurnstileAction;
			theme?: "auto" | "light" | "dark";
		},
	) => string;
	reset: (id?: string) => void;
	remove: (id?: string) => void;
};

declare global {
	interface Window {
		turnstile?: TurnstileApi;
		__turnstileLoading?: Promise<void>;
	}
}

function loadScript(): Promise<void> {
	if (window.turnstile) return Promise.resolve();
	if (window.__turnstileLoading) return window.__turnstileLoading;
	window.__turnstileLoading = new Promise<void>((resolve, reject) => {
		const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
		if (existing) existing.remove();
		const script = document.createElement("script");
		script.id = SCRIPT_ID;
		script.src = SCRIPT_SRC;
		script.async = true;
		script.defer = true;
		let settled = false;
		const finish = (result: "loaded" | "failed") => {
			if (settled) return;
			settled = true;
			window.clearTimeout(timeout);
			if (result === "loaded") resolve();
			else reject(new Error("Turnstile script failed"));
		};
		const timeout = window.setTimeout(() => {
			script.remove();
			finish("failed");
		}, SCRIPT_LOAD_TIMEOUT_MS);
		script.onload = () => finish("loaded");
		script.onerror = () => finish("failed");
		document.head.appendChild(script);
	}).catch((error) => {
		window.__turnstileLoading = undefined;
		throw error;
	});
	return window.__turnstileLoading;
}

export default function Turnstile({
	action,
	onStateChange,
}: {
	action: TurnstileAction;
	onStateChange: (state: TurnstileState) => void;
}) {
	const { t } = useTranslation();
	const ref = useRef<HTMLDivElement>(null);
	const widgetId = useRef<string | null>(null);
	const [revision, setRevision] = useState(0);
	const [state, setState] = useState<TurnstileState>(() =>
		SITE_KEY ? { status: "loading", token: null } : { status: "disabled", token: "" },
	);

	const publish = useCallback((next: TurnstileState) => {
		setState(next);
		onStateChange(next);
	}, [onStateChange]);

	useEffect(() => {
		if (!SITE_KEY) {
			let cancelled = false;
			queueMicrotask(() => {
				if (!cancelled) onStateChange({ status: "disabled", token: "" });
			});
			return () => { cancelled = true; };
		}
		let cancelled = false;
		let completed = false;
		const challengeTimeout = window.setTimeout(() => {
			if (cancelled || completed) return;
			completed = true;
			if (widgetId.current && window.turnstile) window.turnstile.remove(widgetId.current);
			widgetId.current = null;
			publish({ status: "error", token: null });
		}, CHALLENGE_TIMEOUT_MS);
		const finish = (next: TurnstileState) => {
			if (cancelled || completed) return;
			completed = true;
			window.clearTimeout(challengeTimeout);
			publish(next);
		};
		loadScript()
			.then(() => {
				if (cancelled || !ref.current || !window.turnstile) throw new Error("Turnstile API unavailable");
				try {
					widgetId.current = window.turnstile.render(ref.current, {
						sitekey: SITE_KEY,
						action,
						theme: "dark",
						callback: (token) => finish({ status: "verified", token }),
						"expired-callback": () => finish({ status: "expired", token: null }),
						"error-callback": () => finish({ status: "error", token: null }),
						"timeout-callback": () => finish({ status: "error", token: null }),
						"unsupported-callback": () => finish({ status: "error", token: null }),
					});
				} catch {
					finish({ status: "error", token: null });
				}
			})
			.catch(() => {
				finish({ status: "error", token: null });
			});
		return () => {
			cancelled = true;
			completed = true;
			window.clearTimeout(challengeTimeout);
			if (widgetId.current && window.turnstile) {
				window.turnstile.remove(widgetId.current);
				widgetId.current = null;
			}
		};
	}, [action, onStateChange, publish, revision]);

	function retry() {
		publish({ status: "loading", token: null });
		setRevision((value) => value + 1);
	}

	if (!SITE_KEY) return null;
	return (
		<div className="flex w-full flex-col items-center gap-2" aria-live="polite">
			<div ref={ref} className="flex justify-center" />
			{state.status === "loading" ? (
				<p className="text-[12px] text-text-muted">{t("turnstile.checking")}</p>
			) : null}
			{state.status === "expired" || state.status === "error" ? (
				<div className="text-center">
					<p role="alert" className="mb-1 text-[12px] text-danger">
						{state.status === "expired" ? t("turnstile.expired") : t("turnstile.error")}
					</p>
					<button type="button" className="btn-text" onClick={retry}>
						{t("turnstile.retry")}
					</button>
				</div>
			) : null}
		</div>
	);
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnstileState } from "./turnstileState";

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const SCRIPT_ID = "gatopago-dashboard-turnstile-script";
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const SCRIPT_LOAD_TIMEOUT_MS = 10_000;
const CHALLENGE_TIMEOUT_MS = 15_000;

type Api = {
	render(element: HTMLElement, options: {
		sitekey: string;
		action: "email_login";
		callback(token: string): void;
		"expired-callback"(): void;
		"error-callback"(): void;
		"timeout-callback"(): void;
		"unsupported-callback"(): void;
		theme: "dark";
	}): string;
	remove(id: string): void;
};

declare global {
	interface Window {
		turnstile?: Api;
		__dashboardTurnstileLoading?: Promise<void>;
	}
}

function loadScript(): Promise<void> {
	if (window.turnstile) return Promise.resolve();
	if (window.__dashboardTurnstileLoading) return window.__dashboardTurnstileLoading;
	const loading = new Promise<void>((resolve, reject) => {
		const existing = document.getElementById(SCRIPT_ID);
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
			else reject(new Error("Turnstile unavailable"));
		};
		const timeout = window.setTimeout(() => {
			script.remove();
			finish("failed");
		}, SCRIPT_LOAD_TIMEOUT_MS);
		script.onload = () => finish("loaded");
		script.onerror = () => finish("failed");
		document.head.appendChild(script);
	}).catch((error) => {
		window.__dashboardTurnstileLoading = undefined;
		throw error;
	});
	window.__dashboardTurnstileLoading = loading;
	return loading;
}

export default function Turnstile({ onStateChange }: {
	onStateChange(state: TurnstileState): void;
}) {
	const container = useRef<HTMLDivElement>(null);
	const widget = useRef<string | null>(null);
	const [revision, setRevision] = useState(0);
	const [state, setState] = useState<TurnstileState>({ status: "loading", token: null });
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
			if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
			widget.current = null;
			publish({ status: "error", token: null });
		}, CHALLENGE_TIMEOUT_MS);
		const finish = (next: TurnstileState) => {
			if (cancelled || completed) return;
			completed = true;
			window.clearTimeout(challengeTimeout);
			publish(next);
		};
		loadScript().then(() => {
			if (cancelled || !container.current || !window.turnstile) throw new Error("Turnstile API unavailable");
			try {
				widget.current = window.turnstile.render(container.current, {
					sitekey: SITE_KEY,
					action: "email_login",
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
		}).catch(() => {
			finish({ status: "error", token: null });
		});
		return () => {
			cancelled = true;
			completed = true;
			window.clearTimeout(challengeTimeout);
			if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
			widget.current = null;
		};
	}, [onStateChange, publish, revision]);

	function retry() {
		publish({ status: "loading", token: null });
		setRevision((value) => value + 1);
	}

	if (!SITE_KEY) return null;
	return (
		<div aria-live="polite">
			<div ref={container} className="flex justify-center" />
			{state.status === "loading" ? <p className="mt-2 text-[12px] text-text-faint">Comprobando seguridad…</p> : null}
			{state.status === "expired" || state.status === "error" ? (
				<div className="mt-2 text-center">
					<p role="alert" className="text-[12px] text-danger">
						{state.status === "expired" ? "La verificación expiró." : "No pudimos completar la verificación."}
					</p>
					<button type="button" className="btn-text mt-1" onClick={retry}>Intentar de nuevo</button>
				</div>
			) : null}
		</div>
	);
}

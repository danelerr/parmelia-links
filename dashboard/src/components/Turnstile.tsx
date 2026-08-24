import { useCallback, useEffect, useRef, useState } from "react";
import type { TurnstileState } from "./turnstileState";

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type Api = {
	render(element: HTMLElement, options: {
		sitekey: string;
		callback(token: string): void;
		"expired-callback"(): void;
		"error-callback"(): void;
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
		const script = document.createElement("script");
		script.src = SCRIPT_SRC;
		script.async = true;
		script.defer = true;
		script.onload = () => resolve();
		script.onerror = () => reject(new Error("Turnstile unavailable"));
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
		loadScript().then(() => {
			if (cancelled || !container.current || !window.turnstile) return;
			widget.current = window.turnstile.render(container.current, {
				sitekey: SITE_KEY,
				theme: "dark",
				callback: (token) => publish({ status: "verified", token }),
				"expired-callback": () => publish({ status: "expired", token: null }),
				"error-callback": () => publish({ status: "error", token: null }),
			});
		}).catch(() => {
			if (!cancelled) publish({ status: "error", token: null });
		});
		return () => {
			cancelled = true;
			if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
		};
	}, [onStateChange, publish]);

	if (!SITE_KEY) return null;
	return (
		<div aria-live="polite">
			<div ref={container} className="flex justify-center" />
			{state.status === "loading" ? <p className="mt-2 text-[12px] text-text-faint">Comprobando seguridad…</p> : null}
			{state.status === "expired" || state.status === "error" ? (
				<p role="alert" className="mt-2 text-[12px] text-danger">
					La verificación falló. Vuelve atrás e inténtalo de nuevo.
				</p>
			) : null}
		</div>
	);
}

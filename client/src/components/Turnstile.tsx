// Cloudflare Turnstile widget (Managed mode = invisible for humans).
// Reports a token via onToken. If no site key is configured, it reports an
// empty token immediately so dev flows aren't blocked (server skips the check).

import { useEffect, useRef } from "react";

const SITE_KEY = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;
const SCRIPT_SRC = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

type TurnstileApi = {
	render: (
		el: HTMLElement,
		opts: {
			sitekey: string;
			callback: (token: string) => void;
			"expired-callback"?: () => void;
			"error-callback"?: () => void;
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
		const s = document.createElement("script");
		s.src = SCRIPT_SRC;
		s.async = true;
		s.defer = true;
		s.onload = () => resolve();
		s.onerror = () => reject(new Error("turnstile script failed"));
		document.head.appendChild(s);
	});
	return window.__turnstileLoading;
}

export default function Turnstile({ onToken }: { onToken: (token: string) => void }) {
	const ref = useRef<HTMLDivElement>(null);
	const widgetId = useRef<string | null>(null);

	useEffect(() => {
		// Not configured → unblock the flow; the server skips verification.
		if (!SITE_KEY) {
			onToken("");
			return;
		}
		let cancelled = false;
		loadScript()
			.then(() => {
				if (cancelled || !ref.current || !window.turnstile) return;
				widgetId.current = window.turnstile.render(ref.current, {
					sitekey: SITE_KEY,
					theme: "dark",
					callback: (token) => onToken(token),
					"expired-callback": () => {
						onToken("");
						if (widgetId.current) window.turnstile?.reset(widgetId.current);
					},
					"error-callback": () => onToken(""),
				});
			})
			.catch(() => onToken("")); // network/script failure → don't hard-block
		return () => {
			cancelled = true;
			if (widgetId.current && window.turnstile) {
				window.turnstile.remove(widgetId.current);
			}
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	if (!SITE_KEY) return null;
	return <div ref={ref} className="flex justify-center" />;
}

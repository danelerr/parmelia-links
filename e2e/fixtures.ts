import { test as base, expect } from "@playwright/test";

export const test = base.extend({
	page: async ({ page }, use) => {
		await page.addInitScript(() => {
			type TurnstileMode = "verified" | "hang" | "error" | "expired" | "unsupported";
			type TestWindow = Window & typeof globalThis & {
				__turnstileTestMode?: TurnstileMode;
				turnstile?: {
					render(element: HTMLElement, options: Record<string, unknown>): string;
					remove(id?: string): void;
					reset(id?: string): void;
				};
			};
			const target = window as TestWindow;
			target.__turnstileTestMode ??= "verified";
			let sequence = 0;
			const nodes = new Map<string, HTMLElement>();
			const run = (options: Record<string, unknown>) => {
				const mode = target.__turnstileTestMode;
				const callback = mode === "verified" ? options.callback
					: mode === "error" ? options["error-callback"]
						: mode === "expired" ? options["expired-callback"]
							: mode === "unsupported" ? options["unsupported-callback"] : null;
				if (typeof callback === "function") {
					queueMicrotask(() => (callback as (token?: string) => void)(mode === "verified" ? "e2e-turnstile-token" : undefined));
				}
			};
			target.turnstile = {
				render(element, options) {
					const id = `e2e-turnstile-${sequence += 1}`;
					const marker = document.createElement("div");
					marker.dataset.turnstileWidget = id;
					element.replaceChildren(marker);
					nodes.set(id, marker);
					run(options);
					return id;
				},
				remove(id) {
					if (!id) return;
					nodes.get(id)?.remove();
					nodes.delete(id);
				},
				reset() {},
			};
		});
		await use(page);
	},
});

export { expect };

import { pushToast } from "./toastStore";

type NotificationOptions = {
	title: string;
	description?: string;
};

let lastKey = "";
let lastAt = 0;

function notify(kind: "success" | "error", options: NotificationOptions) {
	const key = `${kind}:${options.title}:${options.description ?? ""}`;
	const now = Date.now();
	if (key === lastKey && now - lastAt < 2_000) return;
	lastKey = key;
	lastAt = now;
	pushToast({ kind, ...options });
}

// Compatibility-shaped local facade keeps call sites small while avoiding a
// 46 kB-gzip animation dependency for two simple notification variants.
export const sileo = {
	success: (options: NotificationOptions) => notify("success", options),
	error: (options: NotificationOptions) => notify("error", options),
};

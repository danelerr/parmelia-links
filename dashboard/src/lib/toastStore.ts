export type ToastKind = "success" | "error";

type Toast = {
	id: string;
	kind: ToastKind;
	title: string;
	description?: string;
};

type ToastInput = Omit<Toast, "id"> & { duration?: number };

let toasts: Toast[] = [];
let sequence = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit() {
	for (const listener of listeners) listener();
}

function clearTimer(id: string) {
	const timer = timers.get(id);
	if (timer) clearTimeout(timer);
	timers.delete(id);
}

export function removeToast(id: string) {
	clearTimer(id);
	const next = toasts.filter((toast) => toast.id !== id);
	if (next.length === toasts.length) return;
	toasts = next;
	emit();
}

export function pushToast(input: ToastInput) {
	const id = `dashboard-toast-${Date.now()}-${++sequence}`;
	const next = [{ id, kind: input.kind, title: input.title, description: input.description }, ...toasts].slice(0, 3);
	const retainedIds = new Set(next.map((toast) => toast.id));
	for (const toast of toasts) {
		if (!retainedIds.has(toast.id)) clearTimer(toast.id);
	}
	toasts = next;
	emit();
	const duration = input.duration ?? (input.kind === "error" ? 6_500 : 3_500);
	timers.set(id, setTimeout(() => removeToast(id), duration));
	return id;
}

export function subscribeToasts(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getToasts() {
	return toasts;
}

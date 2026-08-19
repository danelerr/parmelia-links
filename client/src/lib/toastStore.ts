export type ToastKind = "success" | "warning" | "error" | "loading";
export type ToastAction = { title: string; onClick: () => void };

export type ToastItem = {
	id: string;
	kind: ToastKind;
	title: string;
	description?: string;
	action?: ToastAction;
};

type ToastInput = Omit<ToastItem, "id"> & { duration?: number | null };

let items: ToastItem[] = [];
let nextId = 0;
const listeners = new Set<() => void>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emit() {
	for (const listener of listeners) listener();
}

function scheduleRemoval(id: string, duration?: number | null) {
	const previous = timers.get(id);
	if (previous) {
		clearTimeout(previous);
		timers.delete(id);
	}
	if (!duration) return;
	timers.set(id, setTimeout(() => removeToast(id), duration));
}

export function pushToast(input: ToastInput): string {
	const id = `toast-${Date.now()}-${++nextId}`;
	const nextItems = [{ id, kind: input.kind, title: input.title, description: input.description, action: input.action }, ...items].slice(0, 2);
	const retainedIds = new Set(nextItems.map((item) => item.id));
	for (const item of items) {
		if (retainedIds.has(item.id)) continue;
		const timer = timers.get(item.id);
		if (timer) clearTimeout(timer);
		timers.delete(item.id);
	}
	items = nextItems;
	emit();
	scheduleRemoval(id, input.duration);
	return id;
}

export function updateToast(id: string, input: ToastInput): void {
	items = items.map((item) =>
		item.id === id
			? { id, kind: input.kind, title: input.title, description: input.description, action: input.action }
			: item,
	);
	emit();
	scheduleRemoval(id, input.duration);
}

export function removeToast(id: string): void {
	const timer = timers.get(id);
	if (timer) clearTimeout(timer);
	timers.delete(id);
	const next = items.filter((item) => item.id !== id);
	if (next.length === items.length) return;
	items = next;
	emit();
}

export function subscribeToasts(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getToasts(): ToastItem[] {
	return items;
}

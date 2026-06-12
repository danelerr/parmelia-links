// Typed API layer — one place that knows how to talk to the worker.
// Every caller gets parsed JSON or a thrown ApiError with a HUMAN message
// (the server already speaks Spanish in `error`) plus status/requestId,
// instead of re-implementing res.ok / data.error plumbing per page.

import { fetchWithAuth } from "./authFetch";
import type { User } from "./firebase";

export const SERVER_URL =
	import.meta.env.VITE_SERVER_URL || "https://server.parmelia.workers.dev";

export class ApiError extends Error {
	/** HTTP status; 0 = network failure (offline, DNS, CORS). */
	status: number;
	/** Server correlation id — surface it so support can find the log line. */
	requestId?: string;
	network: boolean;

	constructor(
		message: string,
		opts: { status?: number; requestId?: string; network?: boolean } = {},
	) {
		super(message);
		this.name = "ApiError";
		this.status = opts.status ?? 0;
		this.requestId = opts.requestId;
		this.network = opts.network ?? false;
	}
}

type ApiOptions = {
	/** Authenticated requests; omit for public endpoints (pay links, profiles). */
	user?: User | null;
	method?: string;
	body?: unknown;
};

export async function apiFetch<T = Record<string, unknown>>(
	path: string,
	opts: ApiOptions = {},
): Promise<T> {
	const url = path.startsWith("http") ? path : `${SERVER_URL}${path}`;
	const init: RequestInit = {
		method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
	};
	if (opts.body !== undefined) {
		init.headers = { "Content-Type": "application/json" };
		init.body = JSON.stringify(opts.body);
	}

	let res: Response;
	try {
		res = opts.user
			? await fetchWithAuth(opts.user, url, init)
			: await fetch(url, init);
	} catch {
		throw new ApiError("Sin conexión. Revisa tu internet e intenta de nuevo.", {
			status: 0,
			network: true,
		});
	}

	const data = (await res.json().catch(() => null)) as
		| (Record<string, unknown> & { error?: unknown; requestId?: unknown })
		| null;

	if (!res.ok) {
		const serverMessage =
			data && typeof data.error === "string" && data.error.trim()
				? data.error
				: null;
		const fallback =
			res.status >= 500
				? "Tuvimos un problema de nuestro lado. Intenta de nuevo."
				: res.status === 401
					? "Tu sesión expiró. Vuelve a iniciar sesión."
					: "No se pudo completar la operación.";
		throw new ApiError(serverMessage ?? fallback, {
			status: res.status,
			requestId: typeof data?.requestId === "string" ? data.requestId : undefined,
		});
	}

	return (data ?? {}) as T;
}

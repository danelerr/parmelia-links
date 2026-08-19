// Typed API layer for the dashboard — talks to the same Worker as the app.
// All dashboard calls are authenticated with the owner's Firebase session.

import { fetchWithAuth } from "./authFetch";
import type { User } from "./firebase";
import { SERVER_URL } from "./brand";

export { SERVER_URL };

export class ApiError extends Error {
	status: number;
	requestId?: string;
	code?: string;
	constructor(message: string, opts: { status?: number; requestId?: string; code?: string } = {}) {
		super(message);
		this.name = "ApiError";
		this.status = opts.status ?? 0;
		this.requestId = opts.requestId;
		this.code = opts.code;
	}
}

type ApiOptions = { user: User; method?: string; body?: unknown };

export async function apiFetch<T = Record<string, unknown>>(
	path: string,
	opts: ApiOptions,
): Promise<T> {
	const url = path.startsWith("http") ? path : `${SERVER_URL}${path}`;
	const init: RequestInit = { method: opts.method ?? (opts.body !== undefined ? "POST" : "GET") };
	if (opts.body !== undefined) {
		init.headers = { "Content-Type": "application/json" };
		init.body = JSON.stringify(opts.body);
	}

	let res: Response;
	try {
		res = await fetchWithAuth(opts.user, url, init);
	} catch {
		throw new ApiError("Sin conexión. Revisa tu internet e intenta de nuevo.", { status: 0 });
	}

	const data = (await res.json().catch(() => null)) as
		| (Record<string, unknown> & { error?: unknown; error_code?: unknown; requestId?: unknown })
		| null;

	if (!res.ok) {
		const serverMessage =
			data && typeof data.error === "string" && data.error.trim() ? data.error : null;
		const fallback =
			res.status >= 500
				? "Tuvimos un problema de nuestro lado. Intenta de nuevo."
				: res.status === 401
					? "Tu sesión expiró. Vuelve a iniciar sesión."
					: "No se pudo completar la operación.";
		throw new ApiError(serverMessage ?? fallback, {
			status: res.status,
			requestId: typeof data?.requestId === "string" ? data.requestId : undefined,
			code: typeof data?.error_code === "string" ? data.error_code : undefined,
		});
	}

	return (data ?? {}) as T;
}

const DEFAULT_LIMIT = 64 * 1024;

export async function discardResponseBody(response: Response): Promise<void> {
	try {
		await response.body?.cancel();
	} catch {
		// Best effort connection cleanup.
	}
}

export async function readJsonBounded<T>(response: Response, maxBytes = DEFAULT_LIMIT): Promise<T> {
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Response body exceeds limit");
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > maxBytes) throw new Error("Response body exceeds limit");
	return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

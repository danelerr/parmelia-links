const DEFAULT_MAX_JSON_BYTES = 256 * 1024;

export class ResponseBodyTooLargeError extends Error {
	constructor(maxBytes: number) {
		super(`Upstream response exceeded ${maxBytes} bytes`);
		this.name = "ResponseBodyTooLargeError";
	}
}

/** Parse upstream JSON without allowing an untrusted response to fill Worker memory. */
export async function readJsonBounded<T>(
	response: Response,
	maxBytes = DEFAULT_MAX_JSON_BYTES,
): Promise<T> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
		throw new RangeError("maxBytes must be a positive safe integer");
	}
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
		await discardResponseBody(response);
		throw new ResponseBodyTooLargeError(maxBytes);
	}
	if (!response.body) throw new SyntaxError("Upstream response body is empty");

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let bytesRead = 0;
	let text = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytesRead += value.byteLength;
			if (bytesRead > maxBytes) {
				await reader.cancel("response body limit exceeded").catch(() => undefined);
				throw new ResponseBodyTooLargeError(maxBytes);
			}
			text += decoder.decode(value, { stream: true });
		}
		text += decoder.decode();
	} finally {
		reader.releaseLock();
	}
	return JSON.parse(text) as T;
}

/** Release an upstream connection when its body is intentionally ignored. */
export async function discardResponseBody(response: Response): Promise<void> {
	if (response.body) await response.body.cancel().catch(() => undefined);
}

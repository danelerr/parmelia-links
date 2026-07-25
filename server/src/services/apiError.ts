// Uniform error responses for the /v1 + merchant API surface.
//
// One call site shape for every error: the HTTP status comes from the canonical
// ERROR_HTTP_STATUS map (so status and code can't drift), the requestId is always
// attached (for support/log correlation), and the human `error` stays for
// back-compat. `extra` carries the rare non-standard fields (e.g. accountAddress).

import type { Context } from "hono";
import { ERROR_HTTP_STATUS, type ErrorCode } from "../../../shared";
import type { AppContext } from "../middlewares/auth";

// Hono types c.json's status as a ContentfulStatusCode union; our map is a plain
// number. They always agree (4xx/5xx), so narrow with a local cast.
type JsonStatus = Parameters<Context["json"]>[1];

export function apiError(
	c: Context<AppContext>,
	code: ErrorCode,
	message: string,
	extra?: Record<string, unknown>,
) {
	const requestId = c.get("requestId");
	return c.json(
		{ error: message, error_code: code, requestId, ...extra },
		ERROR_HTTP_STATUS[code] as JsonStatus,
	);
}

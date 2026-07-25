type LogValue = string | number | boolean | null | undefined;

type LogFields = Record<string, LogValue>;

const MAX_LOG_TEXT_LENGTH = 2_000;
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const SENSITIVE_FIELD = /^(?:authorization|password|privatekey|secret|token|accesstoken|refreshtoken)$/;

export function sanitizeLogText(value: string): string {
	let sanitized = value
		.replace(
			/\b(authorization|api[-_ ]?key|password|private[-_ ]?key|secret|token)\b(\s*[:=]\s*)(?:Bearer\s+)?[^\s|,}\]]+/gi,
			"$1$2[REDACTED]",
		)
		// RPC providers commonly embed credentials in the host or path, not only
		// in query parameters. Exception text does not need the endpoint itself.
		.replace(/https?:\/\/[^\s|]+/gi, "[REDACTED_URL]");

	if (sanitized.length > MAX_LOG_TEXT_LENGTH) {
		sanitized = `${sanitized.slice(0, MAX_LOG_TEXT_LENGTH)}...[truncated]`;
	}
	return sanitized;
}

function sanitizeFields(fields: LogFields = {}) {
	return Object.fromEntries(
		Object.entries(fields)
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => {
				const normalizedKey = key.replace(/[^a-z]/gi, "").toLowerCase();
				if (SENSITIVE_FIELD.test(normalizedKey)) return [key, "[REDACTED]"];
				return [key, typeof value === "string" ? sanitizeLogText(value) : value];
			}),
	);
}

export function getRequestId(header: (name: string) => string | undefined) {
	const candidate = header("cf-ray") ?? header("x-request-id");
	return candidate && SAFE_REQUEST_ID.test(candidate) ? candidate : crypto.randomUUID();
}

export function extractErrorMessage(error: unknown): string {
	if (!error) return "";
	if (typeof error === "string") return error;

	const err = error as {
		shortMessage?: string;
		details?: string;
		message?: string;
		metaMessages?: string[];
		cause?: { message?: string };
	};

	const parts = [
		err.shortMessage,
		err.details,
		err.message,
		err.cause?.message,
		...(Array.isArray(err.metaMessages) ? err.metaMessages : []),
		String(error),
	].filter((value): value is string => typeof value === "string" && value.trim().length > 0);

	return sanitizeLogText([...new Set(parts)].join(" | "));
}

export function logInfo(event: string, fields?: LogFields) {
	console.log(JSON.stringify({ level: "info", event, ...sanitizeFields(fields) }));
}

export function logWarn(event: string, fields?: LogFields) {
	console.warn(JSON.stringify({ level: "warn", event, ...sanitizeFields(fields) }));
}

export function logError(event: string, error: unknown, fields?: LogFields) {
	console.error(
		JSON.stringify({
			level: "error",
			event,
			message: extractErrorMessage(error),
			...sanitizeFields(fields),
		}),
	);
}

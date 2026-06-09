type LogValue = string | number | boolean | null | undefined;

type LogFields = Record<string, LogValue>;

function sanitizeFields(fields: LogFields = {}) {
	return Object.fromEntries(
		Object.entries(fields).filter(([, value]) => value !== undefined),
	);
}

export function getRequestId(header: (name: string) => string | undefined) {
	return header("cf-ray") ?? header("x-request-id") ?? crypto.randomUUID();
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

	return [...new Set(parts)].join(" | ");
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

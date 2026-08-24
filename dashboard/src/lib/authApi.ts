import { SERVER_URL } from "./brand";

type ErrorPayload = { error?: unknown; error_code?: unknown };

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
	let response: Response;
	try {
		response = await fetch(`${SERVER_URL}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	} catch {
		throw new Error("Sin conexión. Revisa tu internet e intenta de nuevo.");
	}
	const payload = await response.json().catch(() => ({})) as ErrorPayload & T;
	if (!response.ok) {
		const message = typeof payload.error === "string"
			? payload.error
			: "No se pudo completar la operación.";
		throw new Error(message);
	}
	return payload;
}

export function requestEmailCode(input: {
	email: string;
	turnstileToken: string;
}): Promise<{ sent: true; resendAfterSeconds: number }> {
	return post("/auth/email-code/request", { ...input, locale: "es" });
}

export function verifyEmailCode(input: {
	email: string;
	code: string;
}): Promise<{ customToken: string }> {
	return post("/auth/email-code/verify", input);
}

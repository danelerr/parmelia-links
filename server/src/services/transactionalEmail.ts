import type { Bindings } from "../env";

export class TransactionalEmailUnavailableError extends Error {
	constructor(message = "Transactional email is unavailable") {
		super(message);
		this.name = "TransactionalEmailUnavailableError";
	}
}

function senderAddress(env: Bindings): string {
	const value = env.AUTH_EMAIL_FROM?.trim() || "acceso@parmelia.me";
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) {
		throw new TransactionalEmailUnavailableError("AUTH_EMAIL_FROM is invalid");
	}
	return value;
}

type CodeEmailInput = {
	to: string;
	code: string;
	locale: "es" | "en";
	expiresInMinutes: number;
	idempotencyKey?: string;
};

async function sendCodeEmail(
	env: Bindings,
	input: CodeEmailInput,
	copy: { subject: string; intro: string; warning: string; warningColor: string },
): Promise<void> {
	if (!env.EMAIL) throw new TransactionalEmailUnavailableError();
	if (!/^\d{6}$/.test(input.code)) {
		throw new TransactionalEmailUnavailableError("Email code must contain six digits");
	}
	if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.to) || input.to.length > 254) {
		throw new TransactionalEmailUnavailableError("Recipient email is invalid");
	}
	const expiry = input.locale === "es"
		? `Vence en ${input.expiresInMinutes} minutos y sólo se puede usar una vez.`
		: `It expires in ${input.expiresInMinutes} minutes and can only be used once.`;

	try {
		await env.EMAIL.send({
			to: input.to,
			from: { email: senderAddress(env), name: "GatoPago" },
			subject: copy.subject,
			text: `${copy.intro}\n\n${input.code}\n\n${expiry}\n${copy.warning}`,
			html: [
				'<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#171717">',
				`<p>${copy.intro}</p>`,
				`<p style="font-size:32px;font-weight:700;letter-spacing:0.22em;margin:24px 0" translate="no">${input.code}</p>`,
				`<p>${expiry}</p>`,
				`<p style="color:${copy.warningColor}"><strong>${copy.warning}</strong></p>`,
				"</div>",
			].join(""),
		});
	} catch (error) {
		throw new TransactionalEmailUnavailableError(
			error instanceof Error ? error.message : undefined,
		);
	}
}

export function sendEmailSignInCode(
	env: Bindings,
	input: CodeEmailInput,
): Promise<void> {
	const spanish = input.locale === "es";
	return sendCodeEmail(env, input, {
		subject: spanish ? "Tu código para entrar a GatoPago" : "Your GatoPago sign-in code",
		intro: spanish
			? "Usa este código para entrar o crear tu cuenta:"
			: "Use this code to sign in or create your account:",
		warning: spanish
			? "Si no pediste este código, puedes ignorar este correo."
			: "If you did not request this code, you can ignore this email.",
		warningColor: "#666",
	});
}

export function sendEmailStepUpCode(
	env: Bindings,
	input: CodeEmailInput,
): Promise<void> {
	const spanish = input.locale === "es";
	return sendCodeEmail(env, input, {
		subject: spanish
			? "Confirma la recuperación de tu cuenta GatoPago"
			: "Confirm your GatoPago account recovery",
		intro: spanish
			? "Usa este código para confirmar esta acción de recuperación:"
			: "Use this code to confirm this recovery action:",
		warning: spanish
			? "Si no intentaste recuperar tu cuenta, no compartas el código y abre GatoPago para revisar tu seguridad."
			: "If you did not try to recover your account, do not share this code and open GatoPago to review your security.",
		warningColor: "#8a241f",
	});
}

export type SecurityEmailEvent =
	| "security.recovery_proposed"
	| "security.recovery_executed"
	| "security.recovery_cancelled";

function securityEmailCopy(eventType: SecurityEmailEvent): {
	subject: string;
	intro: string;
	action: string;
} {
	if (eventType === "security.recovery_proposed") {
		return {
			subject: "Alerta: se inició la recuperación de tu cuenta GatoPago",
			intro: "Se inició una solicitud para reemplazar las llaves de acceso de tu cuenta.",
			action: "Si no fuiste tú, abre GatoPago y cancélala antes de que termine la espera de seguridad.",
		};
	}
	if (eventType === "security.recovery_executed") {
		return {
			subject: "La recuperación de tu cuenta GatoPago se completó",
			intro: "La llave de recuperación ya reemplazó las llaves anteriores de tu cuenta.",
			action: "Si no reconoces este cambio, contacta soporte inmediatamente desde un canal oficial de GatoPago.",
		};
	}
	return {
		subject: "La recuperación de tu cuenta GatoPago fue cancelada",
		intro: "La solicitud de recuperación pendiente fue cancelada.",
		action: "Tus llaves actuales no cambiaron. Si no reconoces esta acción, revisa la seguridad de tu correo y de tu cuenta.",
	};
}

function securityAppUrl(env: Bindings, path: string | undefined): string | null {
	const base = env.APP_URL?.trim();
	if (!base || !path?.startsWith("/") || path.startsWith("//")) return null;
	try {
		const url = new URL(path, base);
		const expectedOrigin = new URL(base).origin;
		return url.origin === expectedOrigin ? url.toString() : null;
	} catch {
		return null;
	}
}

export async function sendSecurityAlertEmail(
	env: Bindings,
	input: { to: string; eventType: SecurityEmailEvent; link?: string; idempotencyKey?: string },
): Promise<void> {
	if (!env.EMAIL) throw new TransactionalEmailUnavailableError();
	const copy = securityEmailCopy(input.eventType);
	const appUrl = securityAppUrl(env, input.link);
	const linkText = appUrl ? `\n\nAbre GatoPago: ${appUrl}` : "";
	const linkHtml = appUrl
		? `<p><a href="${appUrl}" style="color:#171717;font-weight:700">Abrir GatoPago</a></p>`
		: "";

	try {
		await env.EMAIL.send({
			to: input.to,
			from: { email: senderAddress(env), name: "GatoPago" },
			subject: copy.subject,
			text: `${copy.intro}\n\n${copy.action}${linkText}`,
			html: [
				'<div style="font-family:system-ui,sans-serif;line-height:1.5;color:#171717">',
				`<p><strong>${copy.intro}</strong></p>`,
				`<p>${copy.action}</p>`,
				linkHtml,
				'<p style="color:#666;font-size:13px">Este correo es una alerta de seguridad; no contiene un enlace de inicio de sesión.</p>',
				"</div>",
			].join(""),
		});
	} catch (error) {
		throw new TransactionalEmailUnavailableError(
			error instanceof Error ? error.message : undefined,
		);
	}
}

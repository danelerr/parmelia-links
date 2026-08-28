import { Hono } from "hono";
import type { Context } from "hono";
import { ERR } from "../../../shared";
import { requireAuth, type AppContext } from "../middlewares/auth";
import {
	deleteExpiredEmailCodes,
	emailOtpRateLimitKeys,
	EmailOtpConfigurationError,
	InvalidEmailCodeError,
	issueEmailSignInCode,
	issueEmailStepUpCode,
	normalizeEmail,
	verifyEmailSignInCode,
	verifyEmailStepUpCode,
} from "../services/emailOtp";
import {
	FirebaseAccountDisabledError,
	FirebaseAdminConfigurationError,
	FirebaseVerifiedEmailUnavailableError,
	getVerifiedFirebaseEmailForUid,
} from "../services/googleServiceAccount";
import { logError } from "../services/logger";
import { rateLimitConsume } from "../services/storage";
import { TransactionalEmailUnavailableError } from "../services/transactionalEmail";
import { verifyTurnstile } from "../services/turnstile";

const authRoutes = new Hono<AppContext>();

function requestIp(c: Context<AppContext>): string {
	return c.req.header("CF-Connecting-IP") || "unknown";
}

function maskEmail(email: string): string {
	const [local, domain] = email.split("@");
	const visible = local.slice(0, Math.min(2, local.length));
	return `${visible}${"*".repeat(Math.max(1, Math.min(6, local.length - visible.length)))}@${domain}`;
}

authRoutes.post("/email-code/request", async (c) => {
	const body = await c.req
		.json<Record<string, unknown>>()
		.catch(() => ({} as Record<string, unknown>));
	const email = normalizeEmail(body.email);
	if (!email) {
		return c.json({ error: "Invalid email address", error_code: ERR.INVALID_EMAIL }, 400);
	}
	const ip = requestIp(c);
	try {
		const keys = await emailOtpRateLimitKeys(c.env, email, ip);
		const [ipAllowed, globalAllowed] = await Promise.all([
			rateLimitConsume(c.env, "auth-email-code-ip", keys.ip, 20, 60 * 60, { failClosed: true }),
			rateLimitConsume(c.env, "auth-email-code-global", "all", 2_000, 60 * 60, { failClosed: true }),
		]);
		if (!ipAllowed || !globalAllowed) {
			return c.json({ error: "Too many code requests", error_code: ERR.RATE_LIMITED }, 429);
		}

		const human = await verifyTurnstile(c.env, body.turnstileToken, ip, "email_login");
		if (!human) {
			return c.json({ error: "Human verification failed", error_code: ERR.HUMAN_VERIFY_FAILED }, 403);
		}
		// Only a solved human challenge may consume the address-specific quota;
		// otherwise a bot could lock out any victim address with invalid tokens.
		const emailAllowed = await rateLimitConsume(
			c.env,
			"auth-email-code",
			keys.email,
			3,
			15 * 60,
			{ failClosed: true },
		);
		if (!emailAllowed) {
			return c.json({ error: "Too many code requests", error_code: ERR.RATE_LIMITED }, 429);
		}

		const locale = body.locale === "en" ? "en" as const : "es" as const;
		const result = await issueEmailSignInCode(c.env, { email, ip, locale });
		c.executionCtx.waitUntil(deleteExpiredEmailCodes(c.env).catch(() => undefined));
		return c.json({ sent: true, ...result }, 202);
	} catch (error) {
		logError("auth_email_code_request_failed", error, {
			requestId: c.get("requestId"),
		});
		if (
			error instanceof EmailOtpConfigurationError ||
			error instanceof TransactionalEmailUnavailableError ||
			error instanceof FirebaseAdminConfigurationError
		) {
			return c.json({ error: "Email sign-in is unavailable", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
		}
		return c.json({ error: "Unable to send sign-in code", error_code: ERR.SERVER_ERROR }, 500);
	}
});

authRoutes.post("/email-code/verify", async (c) => {
	const body = await c.req
		.json<Record<string, unknown>>()
		.catch(() => ({} as Record<string, unknown>));
	const email = normalizeEmail(body.email);
	const code = typeof body.code === "string" ? body.code.trim() : "";
	if (!email) {
		return c.json({ error: "Invalid email address", error_code: ERR.INVALID_EMAIL }, 400);
	}
	const ip = requestIp(c);
	try {
		const keys = await emailOtpRateLimitKeys(c.env, email, ip);
		const allowed = await rateLimitConsume(
			c.env,
			"auth-email-verify-ip",
			keys.ip,
			30,
			15 * 60,
			{ failClosed: true },
		);
		if (!allowed) {
			return c.json({ error: "Too many verification attempts", error_code: ERR.RATE_LIMITED }, 429);
		}
		return c.json(await verifyEmailSignInCode(c.env, { email, code }));
	} catch (error) {
		if (error instanceof InvalidEmailCodeError) {
			return c.json({ error: "Invalid or expired code", error_code: ERR.AUTH_CODE_INVALID }, 400);
		}
		if (error instanceof FirebaseAccountDisabledError) {
			return c.json({ error: "Account is disabled", error_code: ERR.AUTH_ACCOUNT_DISABLED }, 403);
		}
		logError("auth_email_code_verify_failed", error, {
			requestId: c.get("requestId"),
		});
		if (
			error instanceof EmailOtpConfigurationError ||
			error instanceof FirebaseAdminConfigurationError
		) {
			return c.json({ error: "Email sign-in is unavailable", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
		}
		return c.json({ error: "Unable to verify sign-in code", error_code: ERR.SERVER_ERROR }, 500);
	}
});

authRoutes.post("/step-up/request", requireAuth, async (c) => {
	const user = c.get("user")!;
	const body = await c.req
		.json<Record<string, unknown>>()
		.catch(() => ({} as Record<string, unknown>));
	const ip = requestIp(c);
	try {
		const anonymousKeys = await emailOtpRateLimitKeys(c.env, "step-up", ip);
		const [userAllowed, ipAllowed, globalAllowed] = await Promise.all([
			rateLimitConsume(c.env, "auth-step-up-user", user.sub, 4, 15 * 60, { failClosed: true }),
			rateLimitConsume(c.env, "auth-step-up-ip", anonymousKeys.ip, 20, 60 * 60, { failClosed: true }),
			rateLimitConsume(c.env, "auth-step-up-global", "all", 2_000, 60 * 60, { failClosed: true }),
		]);
		if (!userAllowed || !ipAllowed || !globalAllowed) {
			return c.json({ error: "Too many code requests", error_code: ERR.RATE_LIMITED }, 429);
		}

		const email = await getVerifiedFirebaseEmailForUid(c.env, user.sub);
		const emailKeys = await emailOtpRateLimitKeys(c.env, email, ip);
		const emailAllowed = await rateLimitConsume(
			c.env,
			"auth-step-up-email",
			emailKeys.email,
			4,
			15 * 60,
			{ failClosed: true },
		);
		if (!emailAllowed) {
			return c.json({ error: "Too many code requests", error_code: ERR.RATE_LIMITED }, 429);
		}

		const locale = body.locale === "en" ? "en" as const : "es" as const;
		const result = await issueEmailStepUpCode(c.env, {
			email,
			ip,
			locale,
			uid: user.sub,
		});
		c.executionCtx.waitUntil(deleteExpiredEmailCodes(c.env).catch(() => undefined));
		return c.json({ sent: true, maskedEmail: maskEmail(email), ...result }, 202);
	} catch (error) {
		if (error instanceof FirebaseAccountDisabledError) {
			return c.json({ error: "Account is disabled", error_code: ERR.AUTH_ACCOUNT_DISABLED }, 403);
		}
		if (error instanceof FirebaseVerifiedEmailUnavailableError) {
			return c.json({ error: "A verified email is required", error_code: ERR.STEP_UP_UNAVAILABLE }, 403);
		}
		logError("auth_step_up_request_failed", error, {
			requestId: c.get("requestId"),
			uid: user.sub,
		});
		if (
			error instanceof EmailOtpConfigurationError ||
			error instanceof TransactionalEmailUnavailableError ||
			error instanceof FirebaseAdminConfigurationError
		) {
			return c.json({ error: "Security verification is unavailable", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
		}
		return c.json({ error: "Unable to send security code", error_code: ERR.SERVER_ERROR }, 500);
	}
});

authRoutes.post("/step-up/verify", requireAuth, async (c) => {
	const user = c.get("user")!;
	const body = await c.req
		.json<Record<string, unknown>>()
		.catch(() => ({} as Record<string, unknown>));
	const code = typeof body.code === "string" ? body.code.trim() : "";
	const ip = requestIp(c);
	try {
		const anonymousKeys = await emailOtpRateLimitKeys(c.env, "step-up", ip);
		const [userAllowed, ipAllowed] = await Promise.all([
			rateLimitConsume(c.env, "auth-step-up-verify-user", user.sub, 12, 15 * 60, { failClosed: true }),
			rateLimitConsume(c.env, "auth-step-up-verify-ip", anonymousKeys.ip, 40, 15 * 60, { failClosed: true }),
		]);
		if (!userAllowed || !ipAllowed) {
			return c.json({ error: "Too many verification attempts", error_code: ERR.RATE_LIMITED }, 429);
		}
		const email = await getVerifiedFirebaseEmailForUid(c.env, user.sub);
		return c.json(await verifyEmailStepUpCode(c.env, {
			email,
			code,
			uid: user.sub,
		}));
	} catch (error) {
		if (error instanceof InvalidEmailCodeError) {
			return c.json({ error: "Invalid or expired code", error_code: ERR.AUTH_CODE_INVALID }, 400);
		}
		if (error instanceof FirebaseAccountDisabledError) {
			return c.json({ error: "Account is disabled", error_code: ERR.AUTH_ACCOUNT_DISABLED }, 403);
		}
		if (error instanceof FirebaseVerifiedEmailUnavailableError) {
			return c.json({ error: "A verified email is required", error_code: ERR.STEP_UP_UNAVAILABLE }, 403);
		}
		logError("auth_step_up_verify_failed", error, {
			requestId: c.get("requestId"),
			uid: user.sub,
		});
		if (
			error instanceof EmailOtpConfigurationError ||
			error instanceof FirebaseAdminConfigurationError
		) {
			return c.json({ error: "Security verification is unavailable", error_code: ERR.SERVICE_UNAVAILABLE }, 503);
		}
		return c.json({ error: "Unable to verify security code", error_code: ERR.SERVER_ERROR }, 500);
	}
});

export default authRoutes;

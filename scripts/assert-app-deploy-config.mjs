import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePaymentsDeployConfig } from "./assert-payments-deploy-config.mjs";
import { classifyLocalCutoverConfig } from "./cutover-preflight-contract.mjs";

const defaultAppConfigPath = resolve(import.meta.dirname, "..", "server", "wrangler.jsonc");
const defaultPaymentsConfigPath = resolve(import.meta.dirname, "..", "payments-worker", "wrangler.jsonc");
export const STABLE_PASSKEY_RP_ID = "app.parmelia.me";

function requiredValue(config, pattern, label) {
	const match = config.match(pattern);
	if (!match) throw new Error(`Refusing App deployment: cannot read ${label}.`);
	return match[1];
}

function exactHttpsOrigin(value, label) {
	try {
		const parsed = new URL(value);
		if (parsed.protocol !== "https:" || parsed.origin !== value ||
			parsed.username || parsed.password || parsed.hostname === "localhost" ||
			parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]") {
			throw new Error("invalid origin");
		}
		return parsed;
	} catch {
		throw new Error(`Refusing App deployment: ${label} must be an exact public HTTPS origin.`);
	}
}

function validatePasskeyDeployConfig(appConfig, appUrl) {
	const rpId = requiredValue(appConfig, /"PASSKEY_RP_ID"\s*:\s*"([^"]+)"/u, "PASSKEY_RP_ID");
	if (rpId !== STABLE_PASSKEY_RP_ID) {
		throw new Error(
			`Refusing App deployment: PASSKEY_RP_ID must remain ${STABLE_PASSKEY_RP_ID} until an explicit credential migration is completed.`,
		);
	}
	if (rpId !== rpId.toLowerCase() || rpId.includes(":") || rpId.includes("/") ||
		!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(rpId)) {
		throw new Error("Refusing App deployment: PASSKEY_RP_ID must be a lowercase DNS hostname.");
	}

	const configuredOrigins = requiredValue(
		appConfig,
		/"PASSKEY_ALLOWED_ORIGINS"\s*:\s*"([^"]+)"/u,
		"PASSKEY_ALLOWED_ORIGINS",
	).split(",").map((origin) => origin.trim());
	if (configuredOrigins.some((origin) => !origin) ||
		new Set(configuredOrigins).size !== configuredOrigins.length) {
		throw new Error("Refusing App deployment: PASSKEY_ALLOWED_ORIGINS must be a non-empty, duplicate-free list.");
	}
	for (const origin of configuredOrigins) {
		const parsed = exactHttpsOrigin(origin, "each PASSKEY_ALLOWED_ORIGINS entry");
		if (parsed.hostname !== rpId && !parsed.hostname.endsWith(`.${rpId}`)) {
			throw new Error(
				"Refusing App deployment: every PASSKEY_ALLOWED_ORIGINS hostname must be the RP ID or one of its subdomains.",
			);
		}
	}
	if (!configuredOrigins.includes(appUrl)) {
		throw new Error("Refusing App deployment: PASSKEY_ALLOWED_ORIGINS must include APP_URL.");
	}
}

export function validateAppDeployConfig(appConfig, paymentsConfig) {
	validatePaymentsDeployConfig(paymentsConfig);
	const appUrl = requiredValue(appConfig, /"APP_URL"\s*:\s*"([^"]+)"/u, "APP_URL");
	exactHttpsOrigin(appUrl, "APP_URL");
	validatePasskeyDeployConfig(appConfig, appUrl);
	const hasEmailBinding = /"send_email"\s*:\s*\[[\s\S]*?"name"\s*:\s*"EMAIL"/u.test(appConfig);
	const emailFrom = appConfig.match(/"AUTH_EMAIL_FROM"\s*:\s*"([^"]+)"/u)?.[1];
	if (hasEmailBinding || emailFrom) {
		if (!emailFrom || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(emailFrom) || emailFrom.length > 254) {
			throw new Error("Refusing App deployment: AUTH_EMAIL_FROM is invalid.");
		}
	}
	if (hasEmailBinding) {
		const senderBlock = appConfig.match(/"send_email"\s*:\s*\[([\s\S]*?)\]\s*,/u)?.[1] ?? "";
		const allowedSenders = [...senderBlock.matchAll(/"([^"\s@]+@[^"\s@]+\.[^"\s@]+)"/gu)]
			.map((match) => match[1]);
		if (!allowedSenders.includes(emailFrom)) {
			throw new Error("Refusing App deployment: AUTH_EMAIL_FROM is not allowed by the EMAIL binding.");
		}
	}
	if (!/"binding"\s*:\s*"PAYMENTS"[\s\S]{0,240}?"service"\s*:\s*"gatopago-payments-api"/u.test(appConfig)) {
		throw new Error("Refusing App deployment: the PAYMENTS Service Binding target is missing or unexpected.");
	}
	const state = classifyLocalCutoverConfig({
		appMode: requiredValue(appConfig, /"PAYMENTS_CUTOVER_MODE"\s*:\s*"([^"]+)"/u, "PAYMENTS_CUTOVER_MODE"),
		appSync: requiredValue(appConfig, /"PAYMENTS_SYNC_ENABLED"\s*:\s*"([^"]+)"/u, "PAYMENTS_SYNC_ENABLED"),
		paymentsBootstrap: requiredValue(paymentsConfig, /"PAYMENTS_BOOTSTRAP_MODE"\s*:\s*"([^"]+)"/u, "PAYMENTS_BOOTSTRAP_MODE"),
		paymentsChecksum: requiredValue(paymentsConfig, /"PAYMENTS_DATA_CUTOVER_CHECKSUM"\s*:\s*"([^"]+)"/u, "PAYMENTS_DATA_CUTOVER_CHECKSUM"),
		targetConfigured: true,
	});
	if (!state.valid) throw new Error(`Refusing App deployment: invalid cutover state: ${state.reason}.`);
	return state;
}

export function assertAppDeployConfig(
	appConfigPath = defaultAppConfigPath,
	paymentsConfigPath = defaultPaymentsConfigPath,
) {
	return validateAppDeployConfig(
		readFileSync(appConfigPath, "utf8"),
		readFileSync(paymentsConfigPath, "utf8"),
	);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try { assertAppDeployConfig(); }
	catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

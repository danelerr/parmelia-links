import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePaymentsDeployConfig } from "./assert-payments-deploy-config.mjs";
import { classifyLocalCutoverConfig } from "./cutover-preflight-contract.mjs";

const defaultAppConfigPath = resolve(import.meta.dirname, "..", "server", "wrangler.jsonc");
const defaultPaymentsConfigPath = resolve(import.meta.dirname, "..", "payments-worker", "wrangler.jsonc");

function requiredValue(config, pattern, label) {
	const match = config.match(pattern);
	if (!match) throw new Error(`Refusing App deployment: cannot read ${label}.`);
	return match[1];
}

export function validateAppDeployConfig(appConfig, paymentsConfig) {
	validatePaymentsDeployConfig(paymentsConfig);
	const appUrl = requiredValue(appConfig, /"APP_URL"\s*:\s*"([^"]+)"/u, "APP_URL");
	try {
		const parsed = new URL(appUrl);
		if (parsed.protocol !== "https:" || parsed.origin !== appUrl) throw new Error("invalid origin");
	} catch {
		throw new Error("Refusing App deployment: APP_URL must be an exact HTTPS origin.");
	}
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

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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyLocalCutoverConfig, isCutoverChecksum } from "./cutover-preflight-contract.mjs";

export const PAYMENTS_DB_SENTINEL = "00000000-0000-0000-0000-000000000002";
const defaultConfigPath = resolve(import.meta.dirname, "..", "payments-worker", "wrangler.jsonc");
const defaultAppConfigPath = resolve(import.meta.dirname, "..", "server", "wrangler.jsonc");

export function validatePaymentsDeployConfig(config) {
	const bootstrap = config.match(/"PAYMENTS_BOOTSTRAP_MODE"\s*:\s*"([^"]+)"/u)?.[1];
	if (bootstrap !== "true" && bootstrap !== "false") {
		throw new Error("Refusing deployment: PAYMENTS_BOOTSTRAP_MODE must be explicitly true or false.");
	}
	const checksum = config.match(/"PAYMENTS_DATA_CUTOVER_CHECKSUM"\s*:\s*"([^"]+)"/u)?.[1];
	if (checksum !== "pending" && !isCutoverChecksum(checksum)) {
		throw new Error("Refusing deployment: PAYMENTS_DATA_CUTOVER_CHECKSUM must be pending or a 64-hex SHA-256 checksum.");
	}
	if (bootstrap === "false" && !isCutoverChecksum(checksum)) {
		throw new Error("Refusing deployment: disabling bootstrap requires a pinned Payments data checksum.");
	}
	const binding = config.match(/"binding"\s*:\s*"PAYMENTS_DB"[\s\S]{0,800}?"database_id"\s*:\s*"([^"]+)"/u);
  if (!binding) throw new Error("Refusing deployment: PAYMENTS_DB must have an explicit database_id.");
  const databaseId = binding[1];
  if (databaseId === PAYMENTS_DB_SENTINEL) {
    throw new Error("Refusing deployment: create PAYMENTS_DB explicitly and replace its local-only sentinel database_id.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(databaseId)) {
    throw new Error("Refusing deployment: PAYMENTS_DB database_id is not a valid Cloudflare D1 UUID.");
  }
  return databaseId;
}

function requiredValue(config, pattern, label) {
	const match = config.match(pattern);
	if (!match) throw new Error(`Refusing deployment: cannot read ${label}.`);
	return match[1];
}

export function assertPaymentsDeployConfig(
	configPath = defaultConfigPath,
	appConfigPath = defaultAppConfigPath,
) {
	const config = readFileSync(configPath, "utf8");
	const databaseId = validatePaymentsDeployConfig(config);
	const appConfig = readFileSync(appConfigPath, "utf8");
	const state = classifyLocalCutoverConfig({
		appMode: requiredValue(appConfig, /"PAYMENTS_CUTOVER_MODE"\s*:\s*"([^"]+)"/u, "PAYMENTS_CUTOVER_MODE"),
		appSync: requiredValue(appConfig, /"PAYMENTS_SYNC_ENABLED"\s*:\s*"([^"]+)"/u, "PAYMENTS_SYNC_ENABLED"),
		paymentsBootstrap: requiredValue(config, /"PAYMENTS_BOOTSTRAP_MODE"\s*:\s*"([^"]+)"/u, "PAYMENTS_BOOTSTRAP_MODE"),
		paymentsChecksum: requiredValue(config, /"PAYMENTS_DATA_CUTOVER_CHECKSUM"\s*:\s*"([^"]+)"/u, "PAYMENTS_DATA_CUTOVER_CHECKSUM"),
		targetConfigured: true,
	});
	if (!state.valid) throw new Error(`Refusing deployment: invalid cutover state: ${state.reason}.`);
	return databaseId;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { assertPaymentsDeployConfig(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

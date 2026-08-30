import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateAppDeployConfig } from "./assert-app-deploy-config.mjs";
import { missingAppSecretNames, requiredAppSecretNames } from "./assert-app-remote-secrets.mjs";
import { PAYMENTS_DB_SENTINEL } from "./assert-payments-deploy-config.mjs";

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function expectRefused(action, expected) {
	let message = "";
	try { action(); } catch (error) { message = error instanceof Error ? error.message : String(error); }
	assert(message.includes(expected), `Unexpected App deploy-guard result: ${message || "accepted unsafe config"}`);
}

const currentApp = readFileSync(resolve(import.meta.dirname, "..", "server", "wrangler.jsonc"), "utf8");
const currentPayments = readFileSync(resolve(import.meta.dirname, "..", "payments-worker", "wrangler.jsonc"), "utf8");
if (currentPayments.includes(PAYMENTS_DB_SENTINEL)) {
	expectRefused(() => validateAppDeployConfig(currentApp, currentPayments), "local-only sentinel");
} else {
	const current = validateAppDeployConfig(currentApp, currentPayments);
	assert(["bootstrap", "frozen", "imported-bootstrap", "target-active", "syncing", "cutover"].includes(current.stage),
		`The current provisioned cutover stage is unsafe: ${current.stage}`);
}

const databaseId = "11111111-2222-4333-8444-555555555555";
const checksum = "11".repeat(32);
const app = (mode, sync) => `{"vars":{"APP_URL":"https://app.gatopago.com","PAYMENTS_CUTOVER_MODE":"${mode}","PAYMENTS_SYNC_ENABLED":"${sync}"},"services":[{"binding":"PAYMENTS","service":"gatopago-payments-api"}]}`;
const payments = (bootstrap, proof) => `{"vars":{"PAYMENTS_BOOTSTRAP_MODE":"${bootstrap}","PAYMENTS_DATA_CUTOVER_CHECKSUM":"${proof}"},"d1_databases":[{"binding":"PAYMENTS_DB","database_id":"${databaseId}"}]}`;

for (const [mode, sync, bootstrap, proof, stage] of [
	["legacy", "false", "true", "pending", "bootstrap"],
	["frozen", "false", "true", "pending", "frozen"],
	["frozen", "false", "true", checksum, "imported-bootstrap"],
	["frozen", "false", "false", checksum, "target-active"],
	["frozen", "true", "false", checksum, "syncing"],
	["payments", "true", "false", checksum, "cutover"],
]) {
	assert(validateAppDeployConfig(app(mode, sync), payments(bootstrap, proof)).stage === stage,
		`Safe ${stage} state was rejected`);
}

for (const [mode, sync, bootstrap, proof] of [
	["legacy", "false", "false", checksum],
	["payments", "false", "false", checksum],
	["payments", "true", "true", "pending"],
	["frozen", "true", "true", "pending"],
]) {
	expectRefused(() => validateAppDeployConfig(app(mode, sync), payments(bootstrap, proof)), "invalid cutover state");
}

expectRefused(
	() => validateAppDeployConfig(app("payments", "true").replace("https://app.gatopago.com", "http://app.gatopago.com"), payments("false", checksum)),
	"APP_URL must be an exact HTTPS origin",
);
const cloudflareWrongSender = app("payments", "true").replace(
	'"services"',
	'"AUTH_EMAIL_FROM":"acceso@app.gatopago.com","send_email":[{"name":"EMAIL","allowed_sender_addresses":["otro@example.com"]}],"services"',
);
expectRefused(
	() => validateAppDeployConfig(cloudflareWrongSender, payments("false", checksum)),
	"is not allowed by the EMAIL binding",
);
const cloudflareReady = app("payments", "true").replace(
	'"services"',
	'"AUTH_EMAIL_FROM":"acceso@app.gatopago.com","send_email":[{"name":"EMAIL","allowed_sender_addresses":["acceso@app.gatopago.com"]}],"services"',
);
assert(validateAppDeployConfig(cloudflareReady, payments("false", checksum)).stage === "cutover",
	"A Cloudflare binding whose allowlist matches AUTH_EMAIL_FROM should pass");

const required = requiredAppSecretNames(app("payments", "true"));
assert(JSON.stringify(required) === JSON.stringify([
	"AUTH_CODE_PEPPER",
	"FIREBASE_SERVICE_ACCOUNT",
	"FIREBASE_WEB_API_KEY",
	"OPS_HEALTH_TOKEN",
	"PRIVATE_KEY",
	"RPC_URL",
	"TURNSTILE_SECRET_KEY",
]), "Firebase magic-link deploys must require only the reviewed App secret inventory");
assert(missingAppSecretNames(app("payments", "true"), required).length === 0,
	"Complete App secret inventories should pass");
assert(missingAppSecretNames(app("payments", "true"), required.filter((name) => name !== "FIREBASE_WEB_API_KEY"))
	.includes("FIREBASE_WEB_API_KEY"), "Missing Firebase email-link credentials must block App deploys");

assert(PAYMENTS_DB_SENTINEL === "00000000-0000-0000-0000-000000000002",
	"Deploy guards disagree about the Payments sentinel");
console.log("App deploy guard check passed for every supported cutover stage.");

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { STABLE_PASSKEY_RP_ID, validateAppDeployConfig } from "./assert-app-deploy-config.mjs";
import {
	assertNoPendingAppMigrations,
	parseD1JsonOutput,
	pendingAppMigrations,
} from "./assert-app-remote-migrations.mjs";
import {
	APP_MULTICHAIN_SCHEMA_EVIDENCE,
	APP_MULTICHAIN_SCHEMA_ITEMS,
	PASSKEY_SECURITY_SCHEMA_EVIDENCE,
	PASSKEY_SECURITY_SCHEMA_ITEMS,
	assertAppMultichainSchemaEvidence,
	assertPasskeySecuritySchemaEvidence,
} from "./app-d1-security-evidence.mjs";
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
const app = (mode, sync) => `{"vars":{"APP_URL":"https://app.parmelia.me","PASSKEY_RP_ID":"${STABLE_PASSKEY_RP_ID}","PASSKEY_ALLOWED_ORIGINS":"https://app.parmelia.me","CHAIN_KEY":"arbitrum-sepolia","APP_ENABLED_CHAIN_KEYS":"arbitrum-sepolia,avalanche-fuji","APP_WALLET_RAIL_CHAIN_KEYS":"arbitrum-sepolia","PAYMENTS_CUTOVER_MODE":"${mode}","PAYMENTS_SYNC_ENABLED":"${sync}"},"services":[{"binding":"PAYMENTS","service":"gatopago-payments-api"}]}`;
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
	() => validateAppDeployConfig(app("payments", "true").replaceAll("https://app.parmelia.me", "http://app.parmelia.me"), payments("false", checksum)),
	"APP_URL must be an exact public HTTPS origin",
);
expectRefused(
	() => validateAppDeployConfig(app("payments", "true").replace(
		`"PASSKEY_RP_ID":"${STABLE_PASSKEY_RP_ID}"`,
		'"PASSKEY_RP_ID":"app.gatopago.com"',
	), payments("false", checksum)),
	"PASSKEY_RP_ID must remain",
);
expectRefused(
	() => validateAppDeployConfig(app("payments", "true").replace(
		'"PASSKEY_ALLOWED_ORIGINS":"https://app.parmelia.me"',
		'"PASSKEY_ALLOWED_ORIGINS":"https://dashboard.parmelia.me"',
	), payments("false", checksum)),
	"must be the RP ID or one of its subdomains",
);
expectRefused(
	() => validateAppDeployConfig(app("payments", "true").replace(
		'"PASSKEY_ALLOWED_ORIGINS":"https://app.parmelia.me"',
		'"PASSKEY_ALLOWED_ORIGINS":"http://app.parmelia.me"',
	), payments("false", checksum)),
	"exact public HTTPS origin",
);
expectRefused(
	() => validateAppDeployConfig(app("payments", "true").replace(
		'"PASSKEY_ALLOWED_ORIGINS":"https://app.parmelia.me"',
		'"PASSKEY_ALLOWED_ORIGINS":"https://login.app.parmelia.me"',
	), payments("false", checksum)),
	"must include APP_URL",
);
expectRefused(
	() => validateAppDeployConfig(app("payments", "true").replace(
		'"APP_ENABLED_CHAIN_KEYS":"arbitrum-sepolia,avalanche-fuji"',
		'"APP_ENABLED_CHAIN_KEYS":"avalanche-fuji"',
	), payments("false", checksum)),
	"must include CHAIN_KEY",
);
expectRefused(
	() => validateAppDeployConfig(app("payments", "true").replace(
		'"APP_WALLET_RAIL_CHAIN_KEYS":"arbitrum-sepolia"',
		'"APP_WALLET_RAIL_CHAIN_KEYS":"base-sepolia"',
	), payments("false", checksum)),
	"must be enabled and implemented",
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
assert(JSON.stringify(pendingAppMigrations(["0035.sql", "0036.sql"], ["0035.sql"])) ===
	JSON.stringify(["0036.sql"]), "The remote migration guard must discover every local pending migration");
expectRefused(
	() => assertNoPendingAppMigrations(["0035.sql", "0036.sql"], ["0035.sql"]),
	"0036.sql",
);
expectRefused(
	() => assertNoPendingAppMigrations([], []),
	"no local App migrations were discovered",
);
assert(assertNoPendingAppMigrations(["0035.sql", "0036.sql"], ["0035.sql", "0036.sql"]).local === 2,
	"A complete remote migration inventory should pass");
const parsedD1 = parseD1JsonOutput('Wrangler banner\n[{"results":[{"name":"0036.sql"}]}]');
assert(parsedD1[0].results[0].name === "0036.sql", "D1 JSON parsing must tolerate a Wrangler banner");
expectRefused(
	() => assertPasskeySecuritySchemaEvidence([]),
	"Passkey Security v2 schema evidence",
);
const completeSchemaEvidence = PASSKEY_SECURITY_SCHEMA_EVIDENCE.map(({ kind, item }) => ({
	kind,
	item,
	present: 1,
}));
assert(assertPasskeySecuritySchemaEvidence(completeSchemaEvidence).schemaEvidence ===
	PASSKEY_SECURITY_SCHEMA_ITEMS.length, "A complete Passkey v2 schema inventory should pass");
expectRefused(
	() => assertPasskeySecuritySchemaEvidence(completeSchemaEvidence.map((row) =>
		row.kind === "index" ? { ...row, kind: "migration" } : row)),
	"idx_passkeys_uid_rp_active",
);
expectRefused(
	() => assertAppMultichainSchemaEvidence([]),
	"Phase 4A multichain schema evidence",
);
const completeMultichainEvidence = APP_MULTICHAIN_SCHEMA_EVIDENCE.map(({ kind, item }) => ({
	kind,
	item,
	present: 1,
}));
assert(assertAppMultichainSchemaEvidence(completeMultichainEvidence).multichainSchemaEvidence ===
	APP_MULTICHAIN_SCHEMA_ITEMS.length, "A complete Phase 4A schema inventory should pass");
expectRefused(
	() => assertAppMultichainSchemaEvidence(completeMultichainEvidence.filter((row) =>
		row.item !== "idx_pending_security_sync_active")),
	"idx_pending_security_sync_active",
);
console.log("App deploy guard check passed for every supported cutover stage.");

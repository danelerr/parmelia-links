import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const deployGuide = readFileSync(resolve(root, "DEPLOY.md"), "utf8");
const serverPackage = JSON.parse(readFileSync(resolve(root, "server", "package.json"), "utf8"));
const paymentsPackage = JSON.parse(readFileSync(resolve(root, "payments-worker", "package.json"), "utf8"));
const appWebDeploy = readFileSync(resolve(root, "scripts", "deploy-phase3-app-web.ps1"), "utf8");
const appWorkerDeploy = readFileSync(resolve(root, "scripts", "deploy-app-worker.mjs"), "utf8");
const sourceGuard = readFileSync(resolve(root, "scripts", "assert-reproducible-deploy-source.mjs"), "utf8");
const appMigrationGuard = readFileSync(resolve(root, "scripts", "assert-app-remote-migrations.mjs"), "utf8");
const appD1Evidence = readFileSync(resolve(root, "scripts", "app-d1-security-evidence.mjs"), "utf8");

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

assert(sourceGuard.includes('"scripts",'),
	"The reproducible-source guard must include its own deployment and validation scripts");

const publishingBypasses = [...deployGuide.matchAll(
	/pnpm\s+--filter\s+(?:server|payments-worker)\s+exec\s+wrangler\s+deploy(?![^\r\n]*--dry-run)[^\r\n]*/gu,
)];
assert(publishingBypasses.length === 0,
	"DEPLOY.md contains a publishing Wrangler command that bypasses the reproducible-source guard");
assert(deployGuide.includes("pnpm --filter server run deploy --dry-run") &&
	deployGuide.includes("pnpm --filter server run deploy --keep-vars --strict"),
"DEPLOY.md must use the guarded package entrypoint for Worker dry-runs and publication");
assert(!/run\s+deploy\s+--\s+--(?:dry-run|keep-vars)/gu.test(deployGuide),
	"DEPLOY.md must not pass a literal separator that can neutralize Wrangler flags");

assert(serverPackage.scripts?.deploy === "node ../scripts/deploy-app-worker.mjs",
	"The App Worker package must use the strict deployment wrapper");
for (const required of [
	"assert-reproducible-deploy-source.mjs",
	"assert-app-deploy-config.mjs",
	"assert-app-remote-migrations.mjs",
	"assert-app-remote-secrets.mjs",
	'"deploy", "--minify"',
	'args.includes("--")',
	'args.length === 1 && args[0] === "--dry-run"',
	"publication requires exactly --keep-vars, --strict and --message <description>",
]) {
	assert(appWorkerDeploy.includes(required), `The strict App Worker deploy wrapper is missing: ${required}`);
}
assert(typeof paymentsPackage.scripts?.deploy === "string" &&
	paymentsPackage.scripts.deploy.includes("assert-reproducible-deploy-source.mjs") &&
	paymentsPackage.scripts.deploy.includes("assert-") && paymentsPackage.scripts.deploy.includes("wrangler deploy"),
	"Payments deploy script must preserve source, configuration and Wrangler guards in one entrypoint");
assert(appMigrationGuard.includes('"--remote", "--json", "--command", APP_D1_SECURITY_EVIDENCE_QUERY') &&
	appMigrationGuard.includes("assertPasskeySecuritySchemaEvidence(evidence)") &&
	appMigrationGuard.includes("assertAppMultichainSchemaEvidence(evidence)") &&
	!/(?:INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|DROP\s+TABLE|ALTER\s+TABLE|CREATE\s+TABLE|REPLACE\s+INTO|migrations\s+apply)/iu.test(`${appMigrationGuard}\n${appD1Evidence}`),
"The App migration deploy guard must remain strictly read-only");

assert(appWebDeploy.includes("assert-reproducible-deploy-source.mjs') client") &&
	appWebDeploy.includes("'deploy', '--prod'") && appWebDeploy.includes("remoteMutationPerformed = $false"),
"Phase 3 App Web deploy must preserve the source guard, production target and non-mutating plan mode");
for (const forbidden of [
	/DashboardDirectory/u,
	/deploysDashboard\s*=\s*\$true/u,
	/deploysPayments\s*=\s*\$true/u,
	/'env'\s*,\s*'add'/u,
	/'project'\s*,\s*'add'/u,
	/'link'\s*,/u,
	/'alias'\s*,\s*'set'/u,
]) {
	assert(!forbidden.test(appWebDeploy),
		`Phase 3 App Web deploy can escape its reviewed App-only scope: ${forbidden}`);
}
assert(deployGuide.includes("pwsh -NoProfile -File scripts/deploy-phase3-app-web.ps1"),
	"DEPLOY.md must use the guarded App-only Vercel entrypoint for Phase 3");

console.log("Worker and App-only web deployment entrypoints are guarded; the runbook cannot bypass them.");

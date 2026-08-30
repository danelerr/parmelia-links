import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const deployGuide = readFileSync(resolve(root, "DEPLOY.md"), "utf8");
const serverPackage = JSON.parse(readFileSync(resolve(root, "server", "package.json"), "utf8"));
const paymentsPackage = JSON.parse(readFileSync(resolve(root, "payments-worker", "package.json"), "utf8"));
const appWebDeploy = readFileSync(resolve(root, "scripts", "deploy-phase3-app-web.ps1"), "utf8");
const sourceGuard = readFileSync(resolve(root, "scripts", "assert-reproducible-deploy-source.mjs"), "utf8");

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
assert(deployGuide.includes("pnpm --filter server run deploy -- --dry-run") &&
	deployGuide.includes("pnpm --filter server run deploy -- --keep-vars --strict"),
"DEPLOY.md must use the guarded package entrypoint for Worker dry-runs and publication");

for (const [name, command] of [
	["server", serverPackage.scripts?.deploy],
	["payments-worker", paymentsPackage.scripts?.deploy],
]) {
	assert(typeof command === "string" && command.includes("assert-reproducible-deploy-source.mjs") &&
		command.includes("assert-") && command.includes("wrangler deploy"),
	`${name} deploy script must preserve source, configuration and Wrangler guards in one entrypoint`);
}

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

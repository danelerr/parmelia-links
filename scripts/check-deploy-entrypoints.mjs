import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const deployGuide = readFileSync(resolve(root, "DEPLOY.md"), "utf8");
const serverPackage = JSON.parse(readFileSync(resolve(root, "server", "package.json"), "utf8"));
const paymentsPackage = JSON.parse(readFileSync(resolve(root, "payments-worker", "package.json"), "utf8"));

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

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

console.log("Worker deployment entrypoints are guarded and the runbook cannot bypass them.");

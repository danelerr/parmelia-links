import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const APP_API = "https://server.parmelia.workers.dev";
const PAYMENTS_API = "https://gatopago-payments-api.parmelia.workers.dev";
const DASHBOARD_ORIGIN = "https://dashboard.parmelia.me";

function directives(csp) {
  return new Map(csp.split(";").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [name, ...values] = entry.split(/\s+/u);
    return [name, values];
  }));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function cspFrom(config, label) {
  const values = config.headers?.flatMap((rule) => rule.headers ?? []) ?? [];
  const csp = values.find((header) => header.key?.toLowerCase() === "content-security-policy")?.value;
  assert.equal(typeof csp, "string", `${label} must declare Content-Security-Policy`);
  return directives(csp);
}

function requireSources(policy, directive, expected, label) {
  const sources = policy.get(directive) ?? [];
  for (const source of expected) {
    assert.ok(sources.includes(source), `${label} ${directive} must allow ${source}`);
  }
  assert.ok(!sources.includes("*"), `${label} ${directive} must not use a global wildcard`);
}

const [clientConfig, dashboardConfig, clientEnv, dashboardEnv, appWrangler, deployHelper] = await Promise.all([
  readJson("client/vercel.json"),
  readJson("dashboard/vercel.json"),
  readFile("client/.env.example", "utf8"),
  readFile("dashboard/.env.example", "utf8"),
  readFile("server/wrangler.jsonc", "utf8"),
  readFile("scripts/deploy-phase2-frontends.ps1", "utf8"),
]);

const clientPolicy = cspFrom(clientConfig, "Client");
assert.equal(dashboardConfig.outputDirectory, "dist", "Dashboard must publish Vite's dist directory");
requireSources(clientPolicy, "connect-src", [
  APP_API,
  PAYMENTS_API,
], "Client");

const dashboardPolicy = cspFrom(dashboardConfig, "Dashboard");
requireSources(dashboardPolicy, "connect-src", [APP_API, PAYMENTS_API], "Dashboard");

for (const [contents, variable, label] of [
  [clientEnv, "VITE_PAYMENTS_API_URL", "Client"],
  [dashboardEnv, "VITE_APP_API_URL", "Dashboard"],
  [dashboardEnv, "VITE_PAYMENTS_API_URL", "Dashboard"],
]) {
  assert.match(contents, new RegExp(`^${variable}=`, "mu"), `${label} env template must declare ${variable}`);
}

assert.match(appWrangler,
  new RegExp(`"ALLOWED_ORIGINS"\\s*:\\s*"[^"]*${DASHBOARD_ORIGIN.replaceAll(".", "\\.")}[^"]*"`, "u"),
  "App Worker CORS must allow the production Dashboard origin");

for (const required of [
  "gatopago-dashboard",
  "dashboard.parmelia.me",
  "VITE_PAYMENTS_API_URL",
  "'deploy', '--prod'",
  "'--no-sensitive'",
  "'--scope'",
  "RedirectStandardInput",
  "[switch] $PlanOnly",
]) {
  assert.ok(deployHelper.includes(required), `Frontend deploy helper must include ${required}`);
}
assert.ok(!deployHelper.includes("--token"), "Frontend deploy helper must never put a Vercel token on argv");
assert.ok(!deployHelper.includes("'--team'"), "Frontend deploy helper must use Vercel's current --scope option");
assert.ok(!/git\s+(?:commit|push)/u.test(deployHelper),
  "Frontend deploy helper must not infer commit/push authorization");

console.log("Frontend deployment boundaries and API origins are configured consistently.");

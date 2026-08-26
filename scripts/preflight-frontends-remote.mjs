import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const checks = [];
const dashboardProjectName = process.env.GATOPAGO_DASHBOARD_VERCEL_PROJECT?.trim() || "gatopago-dashboard";

function clean(output) {
  return String(output ?? "").replaceAll(/\u001b\[[0-9;]*m/gu, "").trim();
}

function run(args, { allowFailure = false, cwd = root } = {}) {
  const windowsCli = process.env.APPDATA
    ? resolve(process.env.APPDATA, "npm", "node_modules", "vercel", "dist", "vc.js")
    : "";
  const useWindowsCli = process.platform === "win32" && windowsCli && existsSync(windowsCli);
  const command = useWindowsCli ? process.execPath : "vercel";
  const commandArgs = useWindowsCli
    ? [windowsCli, ...args, "--no-color"]
    : [...args, "--no-color"];
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = clean(result.stdout);
  const stderr = clean(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(stderr || stdout || `${command} exited ${result.status}`);
  }
  return { ok: result.status === 0, stdout, stderr };
}

function parseJson(output) {
  const start = output.indexOf("{");
  if (start < 0) throw new Error("Vercel did not return JSON");
  return JSON.parse(output.slice(start));
}

function record(id, ok, detail) {
  checks.push({ id, status: ok ? "ready" : "pending", detail });
}

function linkedProject(relativeDirectory) {
  const path = resolve(root, relativeDirectory, ".vercel", "project.json");
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return typeof parsed.projectName === "string" ? parsed.projectName : null;
}

function missingEnv(output, expected) {
  const listedNames = new Set(output.match(/[A-Z][A-Z0-9_]*/gu) ?? []);
  return expected.filter((name) => !listedNames.has(name));
}

const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (flag !== "--json") throw new Error(`Unknown option ${flag}`);
}

const identity = run(["whoami"], { allowFailure: true });
record("vercel-auth", identity.ok, identity.ok ? "Vercel CLI authentication is available" : "Vercel CLI is not authenticated");

if (identity.ok) {
  const projects = parseJson(run(["project", "ls", "--json"]).stdout).projects ?? [];
  const names = new Set(projects.map((project) => project.name));
  const clientProject = linkedProject("client");
  record("client-project", clientProject === "parmelia" && names.has("parmelia"),
    clientProject === "parmelia" && names.has("parmelia")
      ? "Client is linked to the existing parmelia project"
      : "Client is not linked to the expected existing parmelia project");

  const dashboardProject = linkedProject("dashboard");
  record("dashboard-project", dashboardProject === dashboardProjectName && names.has(dashboardProjectName),
    dashboardProject === dashboardProjectName && names.has(dashboardProjectName)
      ? `Dashboard is linked to ${dashboardProjectName}`
      : `${dashboardProjectName} does not exist or dashboard/ is not linked to it`);

  if (clientProject === "parmelia" && names.has("parmelia")) {
    const output = run(["env", "ls", "production"], { cwd: resolve(root, "client") }).stdout;
    const expected = [
      "VITE_FIREBASE_API_KEY", "VITE_FIREBASE_AUTH_DOMAIN", "VITE_FIREBASE_PROJECT_ID",
      "VITE_FIREBASE_STORAGE_BUCKET", "VITE_FIREBASE_MESSAGING_SENDER_ID", "VITE_FIREBASE_APP_ID",
      "VITE_SERVER_URL", "VITE_PAYMENTS_API_URL", "VITE_APP_URL", "VITE_CHAIN_KEY",
      "VITE_TURNSTILE_SITE_KEY",
    ];
    const missing = missingEnv(output, expected);
    record("client-production-env", missing.length === 0,
      missing.length === 0 ? "All required Client production variable names exist"
        : `Missing Client production variable names: ${missing.join(", ")}`);
  } else {
    record("client-production-env", false, "Cannot inspect Client variables until its project link is valid");
  }

  if (dashboardProject === dashboardProjectName && names.has(dashboardProjectName)) {
    const output = run(["env", "ls", "production"], { cwd: resolve(root, "dashboard") }).stdout;
    const expected = [
      "VITE_FIREBASE_API_KEY", "VITE_FIREBASE_AUTH_DOMAIN", "VITE_FIREBASE_PROJECT_ID",
      "VITE_FIREBASE_STORAGE_BUCKET", "VITE_FIREBASE_MESSAGING_SENDER_ID", "VITE_FIREBASE_APP_ID",
      "VITE_APP_API_URL", "VITE_PAYMENTS_API_URL", "VITE_SITE_URL", "VITE_TURNSTILE_SITE_KEY",
    ];
    const missing = missingEnv(output, expected);
    record("dashboard-production-env", missing.length === 0,
      missing.length === 0 ? "All required Dashboard production variable names exist"
        : `Missing Dashboard production variable names: ${missing.join(", ")}`);
  } else {
    record("dashboard-production-env", false, "Cannot inspect Dashboard variables until its project exists and is linked");
  }

  const aliases = run(["alias", "ls"]).stdout;
  record("client-production-alias", /\bapp\.parmelia\.me\b/u.test(aliases),
    /\bapp\.parmelia\.me\b/u.test(aliases) ? "app.parmelia.me is assigned" : "app.parmelia.me is not assigned");
  record("dashboard-production-alias", /\bdashboard\.parmelia\.me\b/u.test(aliases),
    /\bdashboard\.parmelia\.me\b/u.test(aliases)
      ? "dashboard.parmelia.me is assigned"
      : "dashboard.parmelia.me is not assigned");
} else {
  for (const [id, detail] of [
    ["client-project", "Cannot inspect Client project without Vercel authentication"],
    ["dashboard-project", "Cannot inspect Dashboard project without Vercel authentication"],
    ["client-production-env", "Cannot inspect Client variables without Vercel authentication"],
    ["dashboard-production-env", "Cannot inspect Dashboard variables without Vercel authentication"],
    ["client-production-alias", "Cannot inspect Client alias without Vercel authentication"],
    ["dashboard-production-alias", "Cannot inspect Dashboard alias without Vercel authentication"],
  ]) record(id, false, detail);
}

async function checkAnonymousSurface(id, url) {
  try {
    const response = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const location = response.headers.get("location");
    await response.body?.cancel();
    const redirectedOutside = Boolean(location && new URL(location, url).origin !== new URL(url).origin);
    const ok = response.status >= 200 && response.status < 300 && !redirectedOutside;
    record(id, ok, ok
      ? `${url} is anonymously reachable`
      : `${url} returned HTTP ${response.status}${location ? ` with Location ${location}` : ""}`);
  } catch (error) {
    record(id, false, `${url} anonymous check failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

await Promise.all([
  checkAnonymousSurface("client-anonymous-access", "https://app.parmelia.me/"),
  checkAnonymousSurface("dashboard-anonymous-access", "https://dashboard.parmelia.me/"),
]);

const pending = checks.filter((check) => check.status === "pending");
const result = {
  generatedAt: new Date().toISOString(),
  remoteMutationPerformed: false,
  ready: pending.length === 0,
  checks,
  pending: pending.map((check) => check.id),
};

if (flags.has("--json")) console.log(JSON.stringify(result, null, 2));
else {
  for (const check of checks) {
    console.log(`${check.status === "ready" ? "[ready]" : "[pending]"} ${check.id}: ${check.detail}`);
  }
  console.log(result.ready
    ? "Frontend remote configuration is ready."
    : `Frontend remote configuration is not ready: ${result.pending.join(", ")}`);
}
if (!result.ready) process.exitCode = 2;

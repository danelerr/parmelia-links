import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const gates = [
  ["testnet-forks", "run-public-testnet-forks.mjs"],
  ["frontend-readiness", "preflight-frontends-remote.mjs"],
  ["cloudflare-readiness", "preflight-phase2-remote.mjs"],
];
const failures = [];

for (const [name, script] of gates) {
  console.log(`\n=== ${name} ===`);
  const result = spawnSync(process.execPath, [resolve(import.meta.dirname, script)], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    windowsHide: true,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) failures.push({ name, status: result.status });
}

if (failures.length > 0) {
  console.error(`\nRemote read-only verification is not ready: ${failures.map((failure) => `${failure.name}(${failure.status})`).join(", ")}`);
  process.exitCode = 2;
} else {
  console.log("\nRemote read-only verification passed every gate.");
}

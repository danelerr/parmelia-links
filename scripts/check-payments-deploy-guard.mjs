import { cwd, chdir } from "node:process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertPaymentsDeployConfig,
  PAYMENTS_DB_SENTINEL,
  validatePaymentsDeployConfig,
} from "./assert-payments-deploy-config.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const originalCwd = cwd();
try {
  // The package deploy script runs with payments-worker as cwd. The guard must
  // still resolve the repository config from that cwd. Before provisioning it
  // must reject the sentinel; after provisioning it must accept the current
  // safe cutover stage instead of making this test permanently pre-cutover.
  const currentConfig = readFileSync(resolve(import.meta.dirname, "..", "payments-worker", "wrangler.jsonc"), "utf8");
  chdir(resolve(import.meta.dirname, "..", "payments-worker"));
  if (currentConfig.includes(PAYMENTS_DB_SENTINEL)) {
    let rejected = "";
    try { assertPaymentsDeployConfig(); }
    catch (error) { rejected = error instanceof Error ? error.message : String(error); }
    assert(rejected.includes("local-only sentinel"), `Unexpected deploy-guard result: ${rejected || "accepted sentinel"}`);
  } else {
    assert(assertPaymentsDeployConfig() === validatePaymentsDeployConfig(currentConfig),
      "The Payments deploy guard did not accept the current provisioned safe stage");
  }
} finally {
  chdir(originalCwd);
}

const productionId = "11111111-2222-4333-8444-555555555555";
const checksum = "11".repeat(32);
const valid = `{"vars":{"PAYMENTS_BOOTSTRAP_MODE":"true","PAYMENTS_DATA_CUTOVER_CHECKSUM":"pending"},"d1_databases":[{"binding":"PAYMENTS_DB","database_id":"${productionId}"}]}`;
assert(validatePaymentsDeployConfig(valid) === productionId, "A valid explicit Payments D1 id was rejected");
const active = `{"vars":{"PAYMENTS_BOOTSTRAP_MODE":"false","PAYMENTS_DATA_CUTOVER_CHECKSUM":"${checksum}"},"d1_databases":[{"binding":"PAYMENTS_DB","database_id":"${productionId}"}]}`;
assert(validatePaymentsDeployConfig(active) === productionId, "A verified active Payments config was rejected");

for (const invalid of [
  "{}",
	`{"vars":{"PAYMENTS_BOOTSTRAP_MODE":"true","PAYMENTS_DATA_CUTOVER_CHECKSUM":"pending"},"d1_databases":[{"binding":"PAYMENTS_DB","database_id":"${PAYMENTS_DB_SENTINEL}"}]}`,
	`{"vars":{"PAYMENTS_BOOTSTRAP_MODE":"true","PAYMENTS_DATA_CUTOVER_CHECKSUM":"pending"},"d1_databases":[{"binding":"PAYMENTS_DB","database_id":"replace-me"}]}`,
	`{"vars":{"PAYMENTS_BOOTSTRAP_MODE":"false","PAYMENTS_DATA_CUTOVER_CHECKSUM":"pending"},"d1_databases":[{"binding":"PAYMENTS_DB","database_id":"${productionId}"}]}`,
	`{"vars":{"PAYMENTS_BOOTSTRAP_MODE":"false","PAYMENTS_DATA_CUTOVER_CHECKSUM":"not-a-checksum"},"d1_databases":[{"binding":"PAYMENTS_DB","database_id":"${productionId}"}]}`,
]) {
  let refused = false;
  try { validatePaymentsDeployConfig(invalid); }
  catch { refused = true; }
  assert(refused, `Unsafe Payments config was accepted: ${invalid}`);
}

console.log("Payments deploy guard check passed from repository and package working directories.");

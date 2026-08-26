import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertQueueContract,
  assertSnapshotOwnership,
  classifyAppOperationalState,
  classifyAppPaymentDrainState,
  classifyLocalCutoverConfig,
  classifyPaymentsImportState,
  requiresExactPaymentsBaseline,
} from "./cutover-preflight-contract.mjs";

const source = readFileSync(resolve(import.meta.dirname, "preflight-phase2-remote.mjs"), "utf8");
const frontendSource = readFileSync(resolve(import.meta.dirname, "preflight-frontends-remote.mjs"), "utf8");
const paymentsSecretsHelper = readFileSync(resolve(import.meta.dirname, "configure-payments-secrets.ps1"), "utf8");
const protectedPreflightHelper = readFileSync(resolve(import.meta.dirname, "invoke-phase2-preflight.ps1"), "utf8");
const protectedSplitHelper = readFileSync(resolve(import.meta.dirname, "prepare-payments-semantic-split.ps1"), "utf8");
const semanticSplitSource = readFileSync(resolve(import.meta.dirname, "split-payments-d1.mjs"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const forbidden of [
  /wrangler\([\s\S]{0,300}?\[\s*"deploy"/u,
  /wrangler\([\s\S]{0,300}?\[\s*"delete"/u,
  /wrangler\([\s\S]{0,300}?\[\s*"queues"\s*,\s*"create"/u,
  /wrangler\([\s\S]{0,300}?\[\s*"secret"\s*,\s*"put"/u,
  /wrangler\([\s\S]{0,300}?\[\s*"d1"\s*,\s*"migrations"\s*,\s*"apply"/u,
  /wrangler\([\s\S]{0,300}?\[\s*"versions"\s*,\s*"upload"/u,
]) {
  assert(!forbidden.test(source), `Remote Phase 2 preflight contains a mutating Wrangler command: ${forbidden}`);
}

assert((source.match(/\["d1", "execute"/gu) ?? []).length === 1,
  "Remote Phase 2 preflight must route every D1 query through one guarded helper");
assert(source.includes("function d1Read(filter, binding, sql)"),
  "Remote Phase 2 preflight is missing its guarded D1 reader");
assert(source.includes('/^(?:SELECT|PRAGMA)\\b/iu.test(statement)'),
  "Remote Phase 2 preflight must reject non-read-only SQL statements");
assert(source.includes('method: "GET"'),
  "Remote Phase 2 preflight HTTP checks must be explicit read-only GET requests");
assert(source.includes("[429, 500, 502, 503, 504]") && source.includes("attempt < attempts"),
  "Remote Phase 2 preflight must retry bounded transient HTTP failures");
assert(!/method:\s*"(?:POST|PUT|PATCH|DELETE)"/u.test(source),
  "Remote Phase 2 preflight must not make mutating HTTP requests");

for (const forbidden of [
  /\["deploy"/u,
  /\["link"/u,
  /\["project",\s*"add"/u,
  /\["project",\s*"remove"/u,
  /\["env",\s*"add"/u,
  /\["env",\s*"rm"/u,
  /\["alias",\s*"set"/u,
  /\["alias",\s*"remove"/u,
]) {
  assert(!forbidden.test(frontendSource),
    `Frontend remote preflight contains a mutating Vercel command: ${forbidden}`);
}
assert(frontendSource.includes("remoteMutationPerformed: false"),
  "Frontend remote preflight must label its read-only result explicitly");
assert(frontendSource.includes('"VITE_PAYMENTS_API_URL"') &&
  frontendSource.includes("dashboard.parmelia.me"),
"Frontend remote preflight must cover Payments and the Dashboard alias");

assert(source.includes('["d1", "export", "GATOPAGO_DB", "--remote"'),
  "Remote Phase 2 preflight must prove the production snapshot split");
assert(source.includes('["d1", "export", "PAYMENTS_DB", "--remote"') &&
  source.includes('record("payments-semantic-target"') &&
  source.includes('"--verify-target-sql"'),
  "Remote Phase 2 preflight must verify the exact pre-activation Payments export semantically");
assert(source.includes("remoteMutationPerformed: false"),
  "Remote Phase 2 preflight must label its read-only result explicitly");
assert(source.includes("basename(verified).startsWith(prefix)"),
  "Remote Phase 2 preflight must validate its temporary cleanup target");
assert(source.includes('record("payments-checkout-smoke"'),
  "Remote Phase 2 preflight must prove a migrated checkout directly through Payments");
assert(source.includes('record("app-payments-proxy-smoke"'),
  "Remote Phase 2 preflight must prove the App compatibility proxy against the same migrated checkout");
assert(source.includes("assertSnapshotOwnership(manifest.verification)"),
  "Remote Phase 2 preflight must fail closed on missing App/Payments ownership proof");
assert(source.includes('record("payments-import-state"'),
  "Remote Phase 2 preflight must distinguish a pristine import base from unsafe partial data");
assert(source.includes('record("service-binding-target-order"'),
  "Remote Phase 2 preflight must reject an App caller deployed before its target");
assert(source.includes("paymentsSyncEnabled === true") && source.includes("bootstrapActive === false"),
  "Remote Phase 2 preflight must prove sync/bootstrap activation state from live Workers");
assert(source.includes('record("local-cutover-config"') &&
  source.includes('record("payments-configured-checksum"') &&
  source.includes("requiresExactPaymentsBaseline(localCutover.stage)") &&
  source.includes('checks?.dataCutover === "verified"'),
  "Remote Phase 2 preflight must prove the tracked state machine, durable baseline and runtime D1 checksum gate");
assert(!source.includes("legacySafety"),
  "Remote Phase 2 preflight still reads the obsolete legacySafety property");
assert(source.includes("readdirSync(resolve(root, \"payments-worker\", \"migrations\"))"),
  "Remote Phase 2 preflight must discover every Payments migration instead of freezing a stale list");
assert(source.includes('record("app-dead-letters"') && source.includes('record("app-drain"') &&
  source.includes('record("app-public-health"') && source.includes('record("app-core-migrations"'),
  "Remote Phase 2 preflight must fail closed on App migrations, dead letters, drain and public health");
assert(paymentsSecretsHelper.includes("Assert-PaymentRpcSet") &&
  paymentsSecretsHelper.includes('"eth_chainId"') &&
  paymentsSecretsHelper.includes("arbitrum-sepolia-rpc.publicnode.com") &&
  paymentsSecretsHelper.includes("base-sepolia.drpc.org") &&
  paymentsSecretsHelper.includes("base-sepolia.gateway.tenderly.co") &&
  paymentsSecretsHelper.includes("avalanche-fuji-c-chain-rpc.publicnode.com"),
"Payments secret helper must probe two independent RPC hostnames for every enabled testnet before upload");
assert(protectedPreflightHelper.includes("ProtectedData]::Unprotect") &&
  protectedPreflightHelper.includes("preflight:phase2:remote") &&
  protectedPreflightHelper.includes("finally") &&
  !protectedPreflightHelper.includes("Write-Output"),
"Semantic target preflight must inject the existing DPAPI key only into the child process without printing it");
assert(protectedSplitHelper.includes("ProtectedData]::Unprotect") &&
  protectedSplitHelper.includes("split-payments-d1.mjs") &&
  protectedSplitHelper.includes("finally") &&
  !protectedSplitHelper.includes("Write-Output"),
"Semantic split helper must inject the existing DPAPI key only into the child process without printing it");
assert(semanticSplitSource.includes("enc:v2:${spec.id}") &&
  semanticSplitSource.includes('version: 4') && semanticSplitSource.includes('version: 2') &&
  semanticSplitSource.includes('"--verify-target-sql"') &&
  !semanticSplitSource.includes("'legacy-cutover'") && !semanticSplitSource.includes('"legacy-cutover"'),
"Payments split must emit runtime-compatible webhook ciphertext and an independently verifiable semantic manifest");

expectThrows(() => assertSnapshotOwnership({}), "Missing ownership proof was accepted");
expectThrows(() => assertSnapshotOwnership({ ownership: {
  appOwnedCrosschainRows: 3, importedPersonalCrosschainRows: 1,
} }), "Imported personal CCTP was accepted");
assertSnapshotOwnership({ ownership: {
  appOwnedCrosschainRows: 3, importedPersonalCrosschainRows: 0,
} });

const emptyCounts = { merchants: 0, payment_links: 0, payment_intents: 0 };
assert(classifyPaymentsImportState({ legacy_copy_version: 0,
  legacy_copy_completed_at: null, legacy_source_checksum: null,
  legacy_target_checksum: null }, emptyCounts) === "empty",
"A pristine Payments import base was not recognized");
assert(classifyPaymentsImportState({ legacy_copy_version: 0,
  legacy_copy_completed_at: null, legacy_source_checksum: null,
  legacy_target_checksum: null }, { ...emptyCounts, merchants: 1 }) === "unsafe",
"A partially populated Payments import base was accepted");
assert(classifyPaymentsImportState({ legacy_copy_version: 1,
  legacy_copy_completed_at: "2026-08-25T00:00:00.000Z", legacy_source_checksum: "11".repeat(32),
  legacy_target_checksum: "11".repeat(32) }, { ...emptyCounts, merchants: 1 }) === "loaded",
"A completed Payments import was not recognized");
assert(classifyPaymentsImportState({ legacy_copy_version: 1,
  legacy_copy_completed_at: "2026-08-25T00:00:00.000Z", legacy_source_checksum: "abc",
  legacy_target_checksum: "abc" }, { ...emptyCounts, merchants: 1 }) === "unsafe",
"A non-SHA-256 import proof was accepted");

const checksum = "11".repeat(32);
for (const [input, stage] of [
  [{ appMode: "legacy", appSync: "false", paymentsBootstrap: "true",
    paymentsChecksum: "pending", targetConfigured: false }, "preprovision"],
  [{ appMode: "legacy", appSync: "false", paymentsBootstrap: "true",
    paymentsChecksum: "pending", targetConfigured: true }, "bootstrap"],
  [{ appMode: "frozen", appSync: "false", paymentsBootstrap: "true",
    paymentsChecksum: checksum, targetConfigured: true }, "imported-bootstrap"],
  [{ appMode: "frozen", appSync: "false", paymentsBootstrap: "false",
    paymentsChecksum: checksum, targetConfigured: true }, "target-active"],
  [{ appMode: "frozen", appSync: "true", paymentsBootstrap: "false",
    paymentsChecksum: checksum, targetConfigured: true }, "syncing"],
  [{ appMode: "payments", appSync: "true", paymentsBootstrap: "false",
    paymentsChecksum: checksum, targetConfigured: true }, "cutover"],
]) {
  const state = classifyLocalCutoverConfig(input);
  assert(state.valid && state.stage === stage, `Safe local cutover stage was rejected: ${stage}`);
}
for (const input of [
  { appMode: "legacy", appSync: "false", paymentsBootstrap: "false",
    paymentsChecksum: checksum, targetConfigured: true },
  { appMode: "payments", appSync: "false", paymentsBootstrap: "false",
    paymentsChecksum: checksum, targetConfigured: true },
  { appMode: "frozen", appSync: "true", paymentsBootstrap: "true",
    paymentsChecksum: "pending", targetConfigured: true },
]) {
  assert(!classifyLocalCutoverConfig(input).valid, "Unsafe local cutover transition was accepted");
}
assert(requiresExactPaymentsBaseline("target-active"),
  "The pre-activation baseline stopped requiring exact imported counts");
assert(!requiresExactPaymentsBaseline("syncing") && !requiresExactPaymentsBaseline("cutover"),
  "Post-cutover growth would incorrectly fail the baseline preflight");

const cleanApp = {
  payment_reconcile_dead: 0, payment_reconcile_active: 0,
  webhook_delivery_active: 0,
  user_event_dead: 0, user_event_active: 0,
  balance_refresh_active: 0, balance_refresh_failed: 0,
  balance_projection_drift: 0, account_operation_active: 0,
  indexer_registry_active: 0, indexer_registry_failed: 0,
  provider_subscription_active: 0, provider_subscription_failed: 0,
  reorg_replay_active: 0, reorg_replay_failed: 0,
};
assert(JSON.stringify(classifyAppOperationalState(cleanApp)) ===
  JSON.stringify({ valid: true, dead: 0, active: 0 }), "A clean App state was not accepted");
assert(classifyAppOperationalState({ ...cleanApp, user_event_dead: 1 }).dead === 1,
  "A dead App event was not detected");
assert(classifyAppOperationalState({ ...cleanApp, account_operation_active: 2 }).active === 2,
  "Active App operations were not detected");
assert(classifyAppOperationalState({ ...cleanApp, reorg_replay_failed: undefined }).valid === false,
  "Malformed App operational evidence was accepted");
assert(JSON.stringify(classifyAppPaymentDrainState(cleanApp)) ===
  JSON.stringify({ valid: true, active: 0 }), "A clean Payments drain state was not accepted");
assert(classifyAppPaymentDrainState({ ...cleanApp, payment_reconcile_active: 2 }).active === 2,
  "Active payment reconciliation was not detected by the Payments drain gate");
assert(classifyAppPaymentDrainState({ ...cleanApp, webhook_delivery_active: 3 }).active === 3,
  "Active webhook delivery was not detected by the Payments drain gate");
assert(classifyAppPaymentDrainState({ ...cleanApp, balance_refresh_active: 7 }).active === 0,
  "Personal App work incorrectly blocked the Payments drain gate");

assertQueueContract({ label: "test", sourceName: "jobs", producerName: "jobs",
  consumerNames: ["jobs"] });
expectThrows(() => assertQueueContract({ label: "test", sourceName: "wrong",
  producerName: "jobs", consumerNames: ["jobs"] }), "Queue drift was accepted");

console.log("Phase 2 remote preflight is statically read-only and validates safe temporary cleanup.");

function expectThrows(action, message) {
  let threw = false;
  try { action(); } catch { threw = true; }
  assert(threw, message);
}

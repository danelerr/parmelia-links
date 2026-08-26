import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { PAYMENTS_DB_SENTINEL } from "./assert-payments-deploy-config.mjs";
import { classifyLocalCutoverConfig } from "./cutover-preflight-contract.mjs";

const root = resolve(import.meta.dirname, "..");

function files(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function configValue(config, pattern, label) {
  const match = config.match(pattern);
  if (!match) throw new Error(`Wrangler config value is missing: ${label}`);
  return match[1];
}

function queueNames(config) {
  return [...config.matchAll(/"(?:queue|dead_letter_queue)"\s*:\s*"([^"]+)"/gu)]
    .map((match) => match[1]);
}

function sourceConstant(source, name) {
  const constants = [...source.matchAll(/(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]+)"/gu)];
  const match = constants.find((entry) => entry[1] === name);
  if (!match) throw new Error(`Queue source constant is missing: ${name}`);
  return match[2];
}

function producerQueue(config, binding) {
  const producers = [...config.matchAll(/"binding"\s*:\s*"([^"]+)"[\s\S]{0,240}?"queue"\s*:\s*"([^"]+)"/gu)];
  const match = producers.find((entry) => entry[1] === binding);
  if (!match) throw new Error(`Queue producer binding is missing: ${binding}`);
  return match[2];
}

function consumerQueues(config) {
  const block = config.match(/"consumers"\s*:\s*\[([\s\S]*?)\]\s*[,}]/u)?.[1] ?? "";
  return [...block.matchAll(/"queue"\s*:\s*"([^"]+)"/gu)].map((match) => match[1]);
}

const appConfig = readFileSync(join(root, "server", "wrangler.jsonc"), "utf8");
const paymentsConfig = readFileSync(join(root, "payments-worker", "wrangler.jsonc"), "utf8");
const appIndex = readFileSync(join(root, "server", "src", "index.ts"), "utf8");
const appJobs = readFileSync(join(root, "server", "src", "services", "eventJobs.ts"), "utf8");
const appOperationalHealth = readFileSync(join(root, "server", "src", "services", "operationalHealth.ts"), "utf8");
const appRpc = readFileSync(join(root, "server", "src", "services", "paymentsRpc.ts"), "utf8");
const paymentsIndex = readFileSync(join(root, "payments-worker", "src", "index.ts"), "utf8");
const paymentsQueue = readFileSync(join(root, "payments-worker", "src", "services", "queue.ts"), "utf8");
const paymentsJobs = readFileSync(join(root, "payments-worker", "src", "services", "jobs.ts"), "utf8");
const paymentsRepository = readFileSync(join(root, "payments-worker", "src", "repositories", "payments.ts"), "utf8");
const paymentsDataCutover = readFileSync(join(root, "payments-worker", "src", "services", "dataCutover.ts"), "utf8");
const paymentsOpsStore = readFileSync(join(root, "payments-worker", "src", "stores", "opsStore.ts"), "utf8");
const cutoverControl = readFileSync(join(root, "server", "src", "services", "paymentsCutover.ts"), "utf8");
const sharedContract = readFileSync(join(root, "shared", "paymentContracts.ts"), "utf8");

assert(!appConfig.includes('"binding": "PAYMENTS_DB"'), "App Worker must never bind PAYMENTS_DB");
assert(!paymentsConfig.includes('"binding": "GATOPAGO_DB"'), "Payments Worker must never bind GATOPAGO_DB");
assert(appConfig.includes('"binding": "PAYMENTS"') && appConfig.includes('"service": "gatopago-payments-api"'),
  "App -> Payments Service Binding is missing");
assert(!paymentsConfig.includes('"services"'), "Payments must not synchronously depend on another Worker");
const appQueues = queueNames(appConfig);
const paymentQueues = queueNames(paymentsConfig);
assert(appQueues.length > 0 && paymentQueues.length > 0,
  "App and Payments must each declare their own Queue topology");
assert(appQueues.every((name) => !paymentQueues.includes(name)),
  "App and Payments must own different Queues");
const appQueueTransport = sourceConstant(appJobs, "SCHEDULED_JOBS_QUEUE_NAME");
assert(appQueueTransport === producerQueue(appConfig, "SCHEDULED_JOBS_QUEUE") &&
  consumerQueues(appConfig).includes(appQueueTransport),
  "App Queue source constant, producer and consumer must use the same transport name");
const paymentQueueTransport = sourceConstant(paymentsQueue, "PAYMENT_JOBS_QUEUE_NAME");
assert(paymentQueueTransport === producerQueue(paymentsConfig, "PAYMENT_JOBS_QUEUE") &&
  consumerQueues(paymentsConfig).includes(paymentQueueTransport),
  "Payments Queue source constant, producer and consumer must use the same transport name");
assert(appJobs.includes("batch.retryAll") && !appJobs.includes("batch.ackAll()"),
  "App must retry an unexpected Queue batch instead of silently acknowledging it");
assert(paymentsJobs.includes("consumePaymentsWorkerQueue") && paymentsJobs.includes("batch.retryAll"),
  "Payments must validate and retry an unexpected Queue batch");
assert(appIndex.includes("paymentsCutoverAction") && cutoverControl.includes('"block_write"'),
  "App is missing the explicit legacy/frozen/payments cutover control");
assert(appRpc.includes("paymentsBoundarySyncState") && appRpc.includes("if (!paymentsBoundarySyncState(env).enabled) return"),
  "App boundary outbox must remain inert until sync is explicitly enabled after import");
const paymentsDatabaseId = configValue(paymentsConfig,
  /"binding"\s*:\s*"PAYMENTS_DB"[\s\S]{0,800}?"database_id"\s*:\s*"([^"]+)"/u,
  "PAYMENTS_DB database_id");
const localCutover = classifyLocalCutoverConfig({
  appMode: configValue(appConfig, /"PAYMENTS_CUTOVER_MODE"\s*:\s*"([^"]+)"/u,
    "PAYMENTS_CUTOVER_MODE"),
  appSync: configValue(appConfig, /"PAYMENTS_SYNC_ENABLED"\s*:\s*"([^"]+)"/u,
    "PAYMENTS_SYNC_ENABLED"),
  paymentsBootstrap: configValue(paymentsConfig, /"PAYMENTS_BOOTSTRAP_MODE"\s*:\s*"([^"]+)"/u,
    "PAYMENTS_BOOTSTRAP_MODE"),
  paymentsChecksum: configValue(paymentsConfig, /"PAYMENTS_DATA_CUTOVER_CHECKSUM"\s*:\s*"([^"]+)"/u,
    "PAYMENTS_DATA_CUTOVER_CHECKSUM"),
  targetConfigured: paymentsDatabaseId !== PAYMENTS_DB_SENTINEL,
});
assert(localCutover.valid,
  `Tracked App/Payments config is not a safe cutover stage: ${localCutover.reason}`);
assert(paymentsIndex.includes("paymentsWriteAvailability") &&
  paymentsDataCutover.includes("paymentMigrationControl") &&
  paymentsOpsStore.includes("payment_migration_control") &&
  paymentsOpsStore.includes("legacy_source_checksum") &&
  paymentsOpsStore.includes("legacy_target_checksum") &&
  paymentsIndex.includes("batch.retryAll") &&
  paymentsIndex.includes("override async scheduled"),
  "Payments writes are not gated by bootstrap plus the imported D1 checksum across HTTP/RPC/Queue/Cron");
assert(!appIndex.includes("paymentsProxyRoutes"),
  "App must route the compatibility proxy through the centralized cutover gate");
assert(appJobs.includes("legacyPaymentRuntimeEnabled") &&
  appJobs.includes('paymentsCutoverState(env).mode !== "payments"'),
  "Legacy payment jobs are not explicitly gated to the drain/rollback modes");
assert(appJobs.includes("crosschain_relayer: (env) => runCrosschainRelayer(env, 5)") &&
  !cutoverControl.includes('"/crosschain"') &&
  !paymentsIndex.includes('app.route("/crosschain"'),
  "Personal cross-chain transfers must remain App-owned across the Payments cutover");
assert(!cutoverControl.includes('"/pay"') && cutoverControl.includes("paymentLinkPrepareAction") &&
  cutoverControl.includes("paymentSubmissionBlocked"),
  "The global cutover must not freeze App-owned /pay and /crosschain operations");
assert(!/(?:crosschain_operations|webhook_deliveries|payment_intents|payment_fee_ledger)/u.test(appOperationalHealth),
  "App health still reads Payments-owned tables");
assert(sharedContract.includes("interface PaymentsRpcService"), "Shared Payments RPC contract is missing");
assert(appRpc.includes("PaymentsRpcService") && !appRpc.includes("type PaymentsService ="),
  "App must consume the shared Payments RPC contract instead of redeclaring it");
assert(paymentsIndex.includes("implements PaymentsRpcService"),
  "Payments entrypoint must implement the shared RPC contract");
assert(paymentsQueue.includes("PAYMENT_JOB_SCHEDULER.getByName"),
  "Payments delayed jobs are not routed through the partition scheduler");
assert(paymentsJobs.includes('claim.state === "leased"') && paymentsJobs.includes("queueMessage.retry"),
  "Payments Queue may acknowledge a redelivery while another lease is active");
assert(paymentsRepository.includes("payment.created") && paymentsRepository.includes("evt_created_"),
  "Payment creation is missing its deterministic event/outbox transaction");
assert(paymentsConfig.includes('"PAYMENT_LIVE_ENABLED": "false"'),
  "Live payments must remain explicitly disabled in the testnet deployment config");

for (const path of files(join(root, "server", "migrations"))
  .filter((path) => /(?:0033|0034).*\.sql$/u.test(path))) {
  const source = readFileSync(path, "utf8");
  assert(!/CREATE\s+TABLE\s+(?:payment_intents|payment_quotes|payment_attempts|payment_fee_ledger|webhook_endpoints|webhook_deliveries|crosschain_operations)/iu.test(source),
    `Post-boundary App migration creates a Payments-owned table: ${relative(root, path)}`);
}

for (const path of files(join(root, "payments-worker", "src")).filter((path) => path.endsWith(".ts"))) {
  const source = readFileSync(path, "utf8");
  assert(!source.includes("GATOPAGO_DB"), `Payments source references App D1: ${relative(root, path)}`);
  assert(!/(?:\.\.\/)+server\//u.test(source), `Payments imports App implementation: ${relative(root, path)}`);
}

for (const path of files(join(root, "payments-worker", "src"))
  .filter((path) => path.endsWith(".ts") &&
    !path.includes(`${join("src", "repositories")}${sep}`) &&
    !path.includes(`${join("src", "stores")}${sep}`))) {
  const source = readFileSync(path, "utf8");
  assert(!/PAYMENTS_DB\.(?:prepare|batch|exec)/u.test(source),
    `Payments SQL escaped repositories/stores: ${relative(root, path)}`);
}

for (const path of files(join(root, "payments-worker", "src", "services")).filter((path) => path.endsWith(".ts"))) {
  const source = readFileSync(path, "utf8");
  assert(!/CIRCLE_API_(?:BASE_URL|KEY)/u.test(source),
    `Circle provider access escaped the onchain rail: ${relative(root, path)}`);
}

console.log("Backend ownership check passed: two D1s, one-way Service Binding, domain-specific Queue consumers.");

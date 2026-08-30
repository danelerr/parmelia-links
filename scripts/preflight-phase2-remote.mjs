import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { requiredAppSecretNames } from "./assert-app-remote-secrets.mjs";
import { PAYMENTS_DB_SENTINEL } from "./assert-payments-deploy-config.mjs";
import {
  assertQueueContract,
  assertSnapshotOwnership,
  classifyAppOperationalState,
  classifyAppPaymentDrainState,
  classifyLocalCutoverConfig,
  classifyPaymentsImportState,
  isCutoverChecksum,
  requiresExactPaymentsBaseline,
} from "./cutover-preflight-contract.mjs";

const root = resolve(import.meta.dirname, "..");
const appConfigPath = resolve(root, "server", "wrangler.jsonc");
const paymentsConfigPath = resolve(root, "payments-worker", "wrangler.jsonc");
const appConfig = readFileSync(appConfigPath, "utf8");
const paymentsConfig = readFileSync(paymentsConfigPath, "utf8");
const expectedPaymentsMigrations = readdirSync(resolve(root, "payments-worker", "migrations"))
  .filter((name) => /^\d+_.+\.sql$/u.test(name))
  .sort((left, right) => left.localeCompare(right, "en"));
const appJobsSource = readFileSync(resolve(root, "server", "src", "services", "eventJobs.ts"), "utf8");
const paymentsQueueSource = readFileSync(resolve(root, "payments-worker", "src", "services", "queue.ts"), "utf8");
const checks = [];

function value(config, pattern, label) {
  const match = config.match(pattern);
  if (!match) throw new Error(`Cannot read ${label} from Wrangler config`);
  return match[1];
}

const appWorker = value(appConfig, /"name"\s*:\s*"([^"]+)"/u, "App Worker name");
const appDatabaseName = value(appConfig,
  /"binding"\s*:\s*"GATOPAGO_DB"[\s\S]{0,500}?"database_name"\s*:\s*"([^"]+)"/u,
  "App D1 name");
const appDatabaseId = value(appConfig,
  /"binding"\s*:\s*"GATOPAGO_DB"[\s\S]{0,500}?"database_id"\s*:\s*"([^"]+)"/u,
  "App D1 id");
const paymentsWorker = value(paymentsConfig, /"name"\s*:\s*"([^"]+)"/u, "Payments Worker name");
const paymentsDatabaseName = value(paymentsConfig,
  /"binding"\s*:\s*"PAYMENTS_DB"[\s\S]{0,500}?"database_name"\s*:\s*"([^"]+)"/u,
  "Payments D1 name");
const paymentsDatabaseId = value(paymentsConfig,
  /"binding"\s*:\s*"PAYMENTS_DB"[\s\S]{0,500}?"database_id"\s*:\s*"([^"]+)"/u,
  "Payments D1 id");
const appSyncDefault = value(appConfig,
  /"PAYMENTS_SYNC_ENABLED"\s*:\s*"([^"]+)"/u, "App Payments sync default");
const appCutoverDefault = value(appConfig,
  /"PAYMENTS_CUTOVER_MODE"\s*:\s*"([^"]+)"/u, "App Payments cutover mode");
const paymentsBootstrapDefault = value(paymentsConfig,
  /"PAYMENTS_BOOTSTRAP_MODE"\s*:\s*"([^"]+)"/u, "Payments bootstrap default");
const paymentsDataChecksum = value(paymentsConfig,
  /"PAYMENTS_DATA_CUTOVER_CHECKSUM"\s*:\s*"([^"]+)"/u, "Payments data cutover checksum");

function names(config, key) {
  return [...config.matchAll(/"([^"]+)"\s*:\s*"([^"]+)"/gu)]
    .filter((match) => match[1] === key)
    .map((match) => match[2]);
}

const appQueues = [...new Set([...names(appConfig, "queue"), ...names(appConfig, "dead_letter_queue")])];
const paymentsQueues = [...new Set([...names(paymentsConfig, "queue"), ...names(paymentsConfig, "dead_letter_queue")])];
const appConsumerQueues = names(appConfig.match(/"consumers"\s*:\s*\[([\s\S]*?)\]\s*[,}]/u)?.[1] ?? "", "queue");
const paymentsConsumerQueues = names(paymentsConfig.match(/"consumers"\s*:\s*\[([\s\S]*?)\]\s*[,}]/u)?.[1] ?? "", "queue");
const appQueueName = assertQueueContract({
  label: "App",
  sourceName: value(appJobsSource,
    /SCHEDULED_JOBS_QUEUE_NAME\s*=\s*"([^"]+)"/u, "App Queue source constant"),
  producerName: value(appConfig,
    /"binding"\s*:\s*"SCHEDULED_JOBS_QUEUE"[\s\S]{0,240}?"queue"\s*:\s*"([^"]+)"/u,
    "App Queue producer"),
  consumerNames: appConsumerQueues,
});
const paymentsQueueName = assertQueueContract({
  label: "Payments",
  sourceName: value(paymentsQueueSource,
    /PAYMENT_JOBS_QUEUE_NAME\s*=\s*"([^"]+)"/u, "Payments Queue source constant"),
  producerName: value(paymentsConfig,
    /"binding"\s*:\s*"PAYMENT_JOBS_QUEUE"[\s\S]{0,240}?"queue"\s*:\s*"([^"]+)"/u,
    "Payments Queue producer"),
  consumerNames: paymentsConsumerQueues,
});

function clean(output) {
  return String(output ?? "").replaceAll(/\u001b\[[0-9;]*m/gu, "").trim();
}

function runNode(args, { allowFailure = false, env = process.env, cwd = root } = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = clean(result.stdout);
  const stderr = clean(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(clean(stderr || stdout || `node exited ${result.status}`));
  }
  return { ok: result.status === 0, stdout, stderr };
}

function wrangler(filter, args, options) {
  const cli = resolve(root, filter, "node_modules", "wrangler", "bin", "wrangler.js");
  return runNode([cli, ...args], { ...options, cwd: resolve(root, filter) });
}

function d1Read(filter, binding, sql) {
  const statements = sql.split(";").map((statement) => statement.trim()).filter(Boolean);
  if (!statements.length || !statements.every((statement) => /^(?:SELECT|PRAGMA)\b/iu.test(statement))) {
    throw new Error("Phase 2 preflight only permits SELECT and PRAGMA statements");
  }
  return parseJson(wrangler(filter,
    ["d1", "execute", binding, "--remote", "--command", `${statements.join("; ")};`, "--json"]).stdout);
}

function record(id, ok, detail, stage = "cutover") {
  checks.push({ id, status: ok ? "ready" : "pending", stage, detail });
}

function parseJson(output) {
  const array = output.indexOf("[");
  const object = output.indexOf("{");
  const start = [array, object].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) throw new Error("Wrangler did not return JSON");
  return JSON.parse(output.slice(start));
}

function deploymentExists(name, filter) {
  const result = wrangler(filter, ["deployments", "list", "--name", name], { allowFailure: true });
  return result.ok;
}

function secretNames(name, filter) {
  const result = wrangler(filter, ["secret", "list", "--name", name], { allowFailure: true });
  if (!result.ok) return null;
  return parseJson(result.stdout).map((item) => item.name);
}

async function getJson(url, attempts = 3) {
  let result = { ok: false, status: 0, body: null, error: "GET request failed" };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => null);
      result = { ok: response.ok, status: response.status, body };
      if (response.ok || ![429, 500, 502, 503, 504].includes(response.status)) return result;
    } catch (error) {
      result = { ok: false, status: 0, body: null,
        error: error instanceof Error ? error.message : "GET request failed" };
    }
    if (attempt < attempts) await new Promise((resolveDelay) => setTimeout(resolveDelay, 750 * attempt));
  }
  return result;
}

function snapshotSplit() {
  const prefix = "gatopago-phase2-preflight-";
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const absoluteTemp = resolve(tmpdir());
  const absoluteDirectory = resolve(directory);
  if (!absoluteDirectory.startsWith(`${absoluteTemp}\\`) && !absoluteDirectory.startsWith(`${absoluteTemp}/`)) {
    throw new Error("Unsafe Phase 2 preflight directory");
  }
  try {
    const sourceSql = resolve(directory, "app.sql");
    const target = resolve(directory, "payments.sqlite");
    const backups = resolve(directory, "split");
    wrangler("server", ["d1", "export", "GATOPAGO_DB", "--remote", "--output", sourceSql, "-y"]);
    const split = runNode([resolve(root, "scripts", "split-payments-d1.mjs"),
      "--source-sql", sourceSql, "--target", target, "--backup-dir", backups], {
      env: { ...process.env, WEBHOOK_SECRET_ENCRYPTION_KEY: "11".repeat(32),
        WEBHOOK_SECRET_ENCRYPTION_KEY_ID: "preflight-semantic",
        WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS: "{}" },
    });
    const counts = split.stdout.match(/Payments D1 split verified:\s*(\{[^\r\n]+\})/u)?.[1];
    const manifest = JSON.parse(readFileSync(resolve(backups, "split-manifest.json"), "utf8"));
    const ownership = assertSnapshotOwnership(manifest.verification);
    return { counts: counts ? JSON.parse(counts) : null, checksum: manifest.verification?.checksum,
      ownership, manifest };
  } finally {
    const verified = resolve(directory);
    if (basename(verified).startsWith(prefix) &&
      (verified.startsWith(`${absoluteTemp}\\`) || verified.startsWith(`${absoluteTemp}/`))) {
      rmSync(verified, { recursive: true, force: true });
    } else {
      throw new Error("Refusing unsafe Phase 2 preflight cleanup");
    }
  }
}

function verifyPaymentsTargetSnapshot(snapshot) {
  if (!process.env.WEBHOOK_SECRET_ENCRYPTION_KEY?.trim() ||
    !process.env.WEBHOOK_SECRET_ENCRYPTION_KEY_ID?.trim()) {
    throw new Error("Set the active webhook encryption key and key ID only in this preflight process to verify the remote semantic baseline");
  }
  const prefix = "gatopago-payments-target-preflight-";
  const directory = mkdtempSync(join(tmpdir(), prefix));
  const absoluteTemp = resolve(tmpdir());
  const absoluteDirectory = resolve(directory);
  if (!absoluteDirectory.startsWith(`${absoluteTemp}\\`) && !absoluteDirectory.startsWith(`${absoluteTemp}/`)) {
    throw new Error("Unsafe Payments target preflight directory");
  }
  try {
    const targetSql = resolve(directory, "payments.sql");
    const manifestPath = resolve(directory, "semantic-manifest.json");
    writeFileSync(manifestPath, `${JSON.stringify(snapshot.manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    wrangler("payments-worker", ["d1", "export", "PAYMENTS_DB", "--remote", "--output", targetSql, "-y"]);
    const verification = runNode([resolve(root, "scripts", "split-payments-d1.mjs"),
      "--verify-target-sql", targetSql, "--manifest", manifestPath]);
    return verification.stdout;
  } finally {
    const verified = resolve(directory);
    if (basename(verified).startsWith(prefix) &&
      (verified.startsWith(`${absoluteTemp}\\`) || verified.startsWith(`${absoluteTemp}/`))) {
      rmSync(verified, { recursive: true, force: true });
    } else {
      throw new Error("Refusing unsafe Payments target preflight cleanup");
    }
  }
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  for (const flag of flags) {
    if (!["--json", "--skip-snapshot"].includes(flag)) throw new Error(`Unknown option ${flag}`);
  }

  const d1 = parseJson(wrangler("server", ["d1", "list", "--json"]).stdout);
  const source = d1.find((database) => database.name === appDatabaseName);
  const target = d1.find((database) => database.name === paymentsDatabaseName);
  record("app-d1", source?.uuid === appDatabaseId,
    source?.uuid === appDatabaseId ? `${appDatabaseName} is bound to the configured UUID` : `${appDatabaseName} is missing or mismatched`,
    "source");
  const sourceSmokeLink = source?.uuid === appDatabaseId
    ? d1Read("server", "GATOPAGO_DB",
      "SELECT id FROM payment_links ORDER BY created_at DESC, id DESC LIMIT 1")[0]?.results?.[0]
    : null;
  const sourceSmokeLinkId = typeof sourceSmokeLink?.id === "string" ? sourceSmokeLink.id : null;
  const configuredTarget = paymentsDatabaseId !== PAYMENTS_DB_SENTINEL && target?.uuid === paymentsDatabaseId;
  record("payments-d1", configuredTarget,
    configuredTarget ? `${paymentsDatabaseName} exists and matches Wrangler`
      : target ? `${paymentsDatabaseName} exists but Wrangler still has a different/sentinel UUID`
        : `${paymentsDatabaseName} has not been created and Wrangler still uses the sentinel`, "provision");
  const localCutover = classifyLocalCutoverConfig({
    appMode: appCutoverDefault,
    appSync: appSyncDefault,
    paymentsBootstrap: paymentsBootstrapDefault,
    paymentsChecksum: paymentsDataChecksum,
    targetConfigured: configuredTarget,
  });
  record("local-cutover-config", localCutover.valid,
    localCutover.valid
      ? `Tracked App/Payments config is a safe ${localCutover.stage} stage`
      : `Unsafe tracked App/Payments config: ${localCutover.reason}`, "source");
  record("queue-source-contract", appQueueName === "parmelia-scheduled-jobs" &&
    paymentsQueueName === "gatopago-payment-jobs",
    `Queue source/config contracts: App=${appQueueName}, Payments=${paymentsQueueName}`, "source");

  const queueOutput = wrangler("server", ["queues", "list"]).stdout;
  const appQueueReady = appQueues.every((name) => queueOutput.includes(name));
  const paymentsQueueReady = paymentsQueues.every((name) => queueOutput.includes(name));
  record("app-queues", appQueueReady,
    appQueueReady ? `Existing App queues retained: ${appQueues.join(", ")}` : `Missing App queue: ${appQueues.filter((name) => !queueOutput.includes(name)).join(", ")}`,
    "source");
  record("payments-queues", paymentsQueueReady,
    paymentsQueueReady ? `Payments queues exist: ${paymentsQueues.join(", ")}` : `Missing Payments queues: ${paymentsQueues.filter((name) => !queueOutput.includes(name)).join(", ")}`,
    "provision");

  const appDeployed = deploymentExists(appWorker, "server");
  const paymentsDeployed = deploymentExists(paymentsWorker, "payments-worker");
  record("app-worker", appDeployed, appDeployed ? `${appWorker} exists and will be updated in-place` : `${appWorker} is not deployed`, "source");
  record("payments-worker", paymentsDeployed,
    paymentsDeployed ? `${paymentsWorker} has a deployment` : `${paymentsWorker} has not been deployed`, "deploy");

  const coreMigrationNames = ["0030_email_otp.sql", "0031_webauthn_registration.sql", "0032_recovery_step_up.sql"];
  const boundaryNames = ["0033_payments_worker_boundary.sql", "0034_sponsorship_observability.sql"];
  const requiredAppMigrationNames = [...coreMigrationNames, ...boundaryNames];
  const migrations = wrangler("server", ["d1", "migrations", "list", "GATOPAGO_DB", "--remote"]).stdout;
  const appliedBoundary = d1Read("server", "GATOPAGO_DB",
    `SELECT name FROM d1_migrations WHERE name IN ('${requiredAppMigrationNames.join("','")}') ORDER BY name`)[0]?.results ?? [];
  const coreMigrationsApplied = coreMigrationNames.every((name) => appliedBoundary.some((row) => row.name === name));
  record("app-core-migrations", coreMigrationsApplied,
    coreMigrationsApplied ? "0030, 0031 and 0032 are applied"
      : "App core migrations 0030-0032 are missing or partially applied", "source");
  const boundaryApplied = boundaryNames.every((name) => appliedBoundary.some((row) => row.name === name));
  const boundaryPendingInOrder = boundaryNames.every((name) => migrations.includes(name));
  record("app-boundary-migrations", boundaryApplied,
    boundaryApplied ? "0033 and 0034 are applied"
      : boundaryPendingInOrder ? "0033 and 0034 are pending in the correct post-split order"
        : "0033/0034 are partially applied or missing; stop and determine the cutover stage", "app-cutover");

  const appOperationalCounts = d1Read("server", "GATOPAGO_DB", `
    SELECT
      (SELECT COUNT(*) FROM payment_reconcile_requests WHERE status = 'dead') AS payment_reconcile_dead,
      (SELECT COUNT(*) FROM payment_reconcile_requests WHERE status IN ('pending', 'processing', 'failed')) AS payment_reconcile_active,
      (SELECT COUNT(*) FROM webhook_deliveries WHERE status IN ('pending', 'processing')) AS webhook_delivery_active,
      (SELECT COUNT(*) FROM user_event_outbox WHERE status = 'dead') AS user_event_dead,
      (SELECT COUNT(*) FROM user_event_outbox WHERE status IN ('pending', 'processing', 'failed')) AS user_event_active,
      (SELECT COUNT(*) FROM balance_refresh_requests WHERE status IN ('pending', 'processing', 'failed')) AS balance_refresh_active,
      (SELECT COUNT(*) FROM balance_refresh_requests WHERE status = 'failed') AS balance_refresh_failed,
      (SELECT COUNT(*) FROM balance_reconciliation_audits WHERE outcome = 'drift') AS balance_projection_drift,
      (SELECT COUNT(*) FROM account_operations WHERE status IN ('prepared', 'submitted')) AS account_operation_active,
      (SELECT COUNT(*) FROM indexer_wallet_registry_outbox WHERE status IN ('pending', 'failed')) AS indexer_registry_active,
      (SELECT COUNT(*) FROM indexer_wallet_registry_outbox WHERE status = 'failed') AS indexer_registry_failed,
      (SELECT COUNT(*) FROM provider_subscription_state WHERE status IN ('pending', 'failed')) AS provider_subscription_active,
      (SELECT COUNT(*) FROM provider_subscription_state WHERE status = 'failed') AS provider_subscription_failed,
      (SELECT COUNT(*) FROM chain_reorg_replay_requests WHERE status IN ('pending', 'failed')) AS reorg_replay_active,
      (SELECT COUNT(*) FROM chain_reorg_replay_requests WHERE status = 'failed') AS reorg_replay_failed;
  `)[0]?.results?.[0];
  const appOperationalState = classifyAppOperationalState(appOperationalCounts);
  const appPaymentDrainState = classifyAppPaymentDrainState(appOperationalCounts);
  record("app-dead-letters", appOperationalState.valid && appOperationalState.dead === 0,
    appOperationalState.valid
      ? `${appOperationalState.dead} terminal/dead operational rows remain`
      : "App operational counts are missing or malformed", "source");
  record("app-drain", appPaymentDrainState.valid && appPaymentDrainState.active === 0,
    appPaymentDrainState.valid
      ? `${appPaymentDrainState.active} payment-owned operations remain before the snapshot watermark; personal App jobs do not block this cutover`
      : "App payment-drain counts are missing or malformed", "app-cutover");

  const snapshot = flags.has("--skip-snapshot") ? null : snapshotSplit();
  record("production-snapshot-split", !!snapshot,
    snapshot
      ? `Read-only snapshot split passed; checksum ${snapshot.checksum}; counts ${JSON.stringify(snapshot.counts)}; ownership ${JSON.stringify(snapshot.ownership)}`
      : "Snapshot proof was skipped; a full readiness decision requires it", "source");
  const configuredChecksumMatchesSnapshot = !!snapshot && isCutoverChecksum(paymentsDataChecksum) &&
    paymentsDataChecksum.toLowerCase() === snapshot.checksum?.toLowerCase();
  record("payments-configured-checksum", configuredChecksumMatchesSnapshot,
    configuredChecksumMatchesSnapshot
      ? "Payments runtime is pinned to the current frozen import checksum"
      : "Payments runtime checksum is pending or does not match the current frozen snapshot",
    "data-cutover");

  let paymentsMigrationsApplied = false;
  if (configuredTarget) {
    const targetMigrations = wrangler("payments-worker",
      ["d1", "migrations", "list", "PAYMENTS_DB", "--remote"]).stdout;
    const pending = expectedPaymentsMigrations
      .filter((name) => targetMigrations.includes(name));
    paymentsMigrationsApplied = pending.length === 0;
    record("payments-migrations", paymentsMigrationsApplied,
      paymentsMigrationsApplied ? "Payments migrations are applied" : `Pending Payments migrations: ${pending.join(", ")}`,
      "schema");
  } else {
    record("payments-migrations", false, "Cannot inspect Payments migrations until PAYMENTS_DB is provisioned", "schema");
  }

  let paymentsCutoverLoaded = false;
  let paymentsImportState = "unavailable";
  let targetState = null;
  if (configuredTarget && paymentsMigrationsApplied) {
    targetState = d1Read("payments-worker", "PAYMENTS_DB", `
      SELECT legacy_copy_version, legacy_copy_completed_at, legacy_source_checksum, legacy_target_checksum
        FROM payment_migration_control WHERE id = 1;
      SELECT (SELECT COUNT(*) FROM merchants) AS merchants,
        (SELECT COUNT(*) FROM payment_links) AS payment_links,
        (SELECT COUNT(*) FROM payment_intents) AS payment_intents,
        (SELECT COUNT(*) FROM payment_quotes) AS payment_quotes,
        (SELECT COUNT(*) FROM payment_attempts) AS payment_attempts,
        (SELECT COUNT(*) FROM payment_fee_ledger) AS payment_fee_ledger,
        (SELECT COUNT(*) FROM api_keys) AS api_keys,
        (SELECT COUNT(*) FROM webhook_endpoints) AS webhook_endpoints,
        (SELECT COUNT(*) FROM events) AS events,
        (SELECT COUNT(*) FROM webhook_deliveries) AS webhook_deliveries,
        (SELECT COUNT(*) FROM crosschain_operations) AS crosschain_operations;
      PRAGMA quick_check;
      PRAGMA foreign_key_check;
    `);
    const control = targetState[0]?.results?.[0];
    const targetCounts = targetState[1]?.results?.[0] ?? null;
    const quick = targetState[2]?.results?.[0]?.quick_check;
    const foreignKeyErrors = targetState[3]?.results?.length ?? -1;
    paymentsImportState = quick === "ok" && foreignKeyErrors === 0
      ? classifyPaymentsImportState(control, targetCounts) : "unsafe";
    record("payments-import-state", paymentsImportState !== "unsafe",
      paymentsImportState === "empty"
        ? "Payments schema is pristine and ready for one data-only import"
        : paymentsImportState === "loaded"
          ? "Payments import control is complete and internally consistent"
          : "Payments D1 is neither a pristine import base nor a completed cutover",
      "data-cutover");
    if (snapshot) {
		const countMatch = Object.entries(snapshot.counts ?? {})
			.every(([name, count]) => targetCounts?.[name] === count);
		const checksumMatch = control?.legacy_source_checksum === snapshot.checksum &&
			control?.legacy_target_checksum === snapshot.checksum;
		const exactBaselineRequired = requiresExactPaymentsBaseline(localCutover.stage);
		let targetSemanticVerified = !exactBaselineRequired;
		let targetSemanticDetail = "Post-cutover target content can change; the immutable import proof remains pinned";
		if (exactBaselineRequired) {
			try {
				targetSemanticDetail = verifyPaymentsTargetSnapshot(snapshot);
				targetSemanticVerified = true;
			} catch (error) {
				targetSemanticDetail = error instanceof Error ? error.message : "Payments semantic target verification failed";
			}
		}
		record("payments-semantic-target", targetSemanticVerified, targetSemanticDetail, "data-cutover");
		paymentsCutoverLoaded = paymentsImportState === "loaded" && configuredChecksumMatchesSnapshot &&
			checksumMatch && (!exactBaselineRequired || countMatch) && targetSemanticVerified &&
			quick === "ok" && foreignKeyErrors === 0;
		record("payments-cutover-data", paymentsCutoverLoaded,
			paymentsCutoverLoaded
				? exactBaselineRequired
					? `Payments data matches source checksum ${snapshot.checksum}, semantic target export, exact baseline counts, quick_check and foreign keys`
					: `Payments preserves source checksum ${snapshot.checksum}, quick_check and foreign keys; post-cutover counts may grow`
				: "Payments data-only import is absent or does not match the current source snapshot", "data-cutover");
    }
  } else {
    record("payments-import-state", false,
      "Cannot prove a pristine or completed Payments import until D1 and migrations exist",
      "data-cutover");
  }
  if (!snapshot || !configuredTarget || !paymentsMigrationsApplied) {
    record("payments-semantic-target", false,
      "Cannot verify the semantic target export until Payments D1, migrations and a current source snapshot are available",
      "data-cutover");
    record("payments-cutover-data", false,
      "Cannot prove the data-only cutover until Payments D1, migrations and a current source snapshot are available",
      "data-cutover");
  }

  const appSecrets = secretNames(appWorker, "server");
  const appRequired = requiredAppSecretNames(appConfig);
  record("app-secrets", !!appSecrets && appRequired.every((name) => appSecrets.includes(name)),
    appSecrets ? `App secret names present: ${appRequired.filter((name) => appSecrets.includes(name)).join(", ")}`
      : "Cannot list App secrets", "source");
  const paymentsSecrets = secretNames(paymentsWorker, "payments-worker");
  const paymentsRequired = ["PAYMENT_AUTHORIZATION_SIGNER_PRIVATE_KEY", "PAYMENT_RPC_URLS",
    "PAYMENT_RELAYER_PRIVATE_KEY", "WEBHOOK_SECRET_ENCRYPTION_KEY",
    "WEBHOOK_SECRET_ENCRYPTION_KEY_ID", "OPS_HEALTH_TOKEN"];
  const missingPaymentSecrets = paymentsSecrets
    ? paymentsRequired.filter((name) => !paymentsSecrets.includes(name)) : paymentsRequired;
  record("payments-secrets", missingPaymentSecrets.length === 0,
    missingPaymentSecrets.length === 0 ? "All required Payments secret names exist"
      : `Missing Payments secret names: ${missingPaymentSecrets.join(", ")}`, "secrets");

  const workersSubdomain = process.env.CLOUDFLARE_WORKERS_SUBDOMAIN ?? "parmelia";
  const appBaseUrl = `https://${appWorker}.${workersSubdomain}.workers.dev`;
  const paymentsBaseUrl = `https://${paymentsWorker}.${workersSubdomain}.workers.dev`;
  const appLive = await getJson(`${appBaseUrl}/health/live`);
  const appHealth = await getJson(`${appBaseUrl}/health`);
  record("app-public-health", appHealth.ok && appHealth.body?.status === "ok",
    appHealth.ok
      ? `App public health is ${appHealth.body?.status ?? "unknown"} with ${appHealth.body?.warningCount ?? "unknown"} warnings`
      : `App public health failed (HTTP ${appHealth.status})`, "source");
  const appBoundaryDeployed = appLive.ok && appLive.body?.paymentsBoundaryVersion === 2 &&
    appLive.body?.paymentsSyncEnabled === true && appLive.body?.paymentsSyncConfigValid === true;
  record("app-boundary-deployment", appBoundaryDeployed,
    appBoundaryDeployed ? "App boundary version 2 is live"
      : `App boundary v2 with sync enabled is not live (HTTP ${appLive.status})`, "deploy");
  record("service-binding-target-order", !appBoundaryDeployed || paymentsDeployed,
    !appBoundaryDeployed || paymentsDeployed
      ? "No App caller is active without an existing Payments target"
      : "App boundary v2 is active before the Payments Service Binding target exists", "deploy");
  let paymentsReady = false;
  if (paymentsDeployed) {
    const paymentsLive = await getJson(`${paymentsBaseUrl}/health/live`);
    const paymentsHealth = await getJson(`${paymentsBaseUrl}/health`);
    paymentsReady = paymentsLive.ok && paymentsLive.body?.bootstrapActive === false &&
      paymentsLive.body?.bootstrapConfigValid === true &&
      paymentsHealth.ok && paymentsHealth.body?.status === "ready" &&
      paymentsHealth.body?.checks?.dataCutover === "verified";
    record("payments-health", paymentsReady,
      paymentsReady ? "Payments readiness is healthy"
        : `Payments is absent, bootstrapping or not healthy (HTTP ${paymentsHealth.status})`, "smoke");
  } else {
    record("payments-health", false, "Payments cannot be smoke-tested before its first deployment", "smoke");
  }

  let directCheckout = null;
  if (paymentsReady && paymentsCutoverLoaded && sourceSmokeLinkId) {
    directCheckout = await getJson(`${paymentsBaseUrl}/checkout/${encodeURIComponent(sourceSmokeLinkId)}`);
  }
  const directCheckoutReady = !!directCheckout?.ok &&
    directCheckout.body?.link?.id === sourceSmokeLinkId &&
    directCheckout.body?.link?.intentId === directCheckout.body?.intent?.id;
  record("payments-checkout-smoke", directCheckoutReady,
    directCheckoutReady
      ? "A migrated production checkout resolves directly through Payments"
      : !sourceSmokeLinkId
        ? "No production payment link is available for a migrated checkout smoke"
        : !paymentsCutoverLoaded
          ? "A production checkout cannot be tested until the verified data cutover is loaded"
          : !paymentsReady
            ? "A production checkout cannot be tested until Payments is ready"
            : `Direct Payments checkout failed or returned inconsistent link/intent data (HTTP ${directCheckout?.status ?? 0})`,
    "smoke");

  let proxyCheckout = null;
  if (directCheckoutReady && appBoundaryDeployed) {
    proxyCheckout = await getJson(`${appBaseUrl}/checkout/${encodeURIComponent(sourceSmokeLinkId)}`);
  }
  const proxyCheckoutReady = !!proxyCheckout?.ok &&
    proxyCheckout.body?.link?.id === sourceSmokeLinkId &&
    proxyCheckout.body?.link?.intentId === proxyCheckout.body?.intent?.id &&
    proxyCheckout.body?.intent?.id === directCheckout?.body?.intent?.id;
  record("app-payments-proxy-smoke", proxyCheckoutReady,
    proxyCheckoutReady
      ? "A migrated production checkout resolves through the App compatibility proxy"
      : !directCheckoutReady
        ? "App proxy smoke waits for a successful direct Payments checkout"
        : !appBoundaryDeployed
          ? "App proxy smoke waits for boundary version 2 to be live"
          : `App proxy checkout failed or diverged from Payments (HTTP ${proxyCheckout?.status ?? 0})`,
    "smoke");

  const pending = checks.filter((check) => check.status === "pending");
  const result = {
    generatedAt: new Date().toISOString(),
    remoteMutationPerformed: false,
    ready: pending.length === 0,
    appWorker,
    paymentsWorker,
    checks,
    pending: pending.map((check) => check.id),
  };
  if (flags.has("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    for (const check of checks) console.log(`${check.status === "ready" ? "[ready]" : "[pending]"} ${check.id}: ${check.detail}`);
    console.log(result.ready ? "Phase 2 remote cutover is fully promoted." : `Phase 2 remote cutover is not ready: ${result.pending.join(", ")}`);
  }
  if (!result.ready) process.exitCode = 2;
}

try { await main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

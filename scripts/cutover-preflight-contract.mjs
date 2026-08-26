export function assertSnapshotOwnership(verification) {
  const ownership = verification?.ownership;
  if (!ownership || !Number.isSafeInteger(ownership.appOwnedCrosschainRows) ||
    ownership.appOwnedCrosschainRows < 0 ||
    !Number.isSafeInteger(ownership.importedPersonalCrosschainRows) ||
    ownership.importedPersonalCrosschainRows !== 0) {
    throw new Error("Snapshot ownership proof is missing or imported personal CCTP into Payments");
  }
  return ownership;
}

export function classifyPaymentsImportState(control, counts) {
  if (!control || !counts || Object.values(counts).some((count) =>
    !Number.isSafeInteger(count) || count < 0)) return "unsafe";
  const empty = Object.values(counts).every((count) => count === 0);
  const pristine = control.legacy_copy_version === 0 &&
    control.legacy_copy_completed_at === null &&
    control.legacy_source_checksum === null &&
    control.legacy_target_checksum === null;
  const loaded = control.legacy_copy_version === 1 &&
    typeof control.legacy_copy_completed_at === "string" &&
    control.legacy_copy_completed_at.length > 0 &&
    typeof control.legacy_source_checksum === "string" &&
    /^[0-9a-f]{64}$/iu.test(control.legacy_source_checksum) &&
    control.legacy_source_checksum === control.legacy_target_checksum;
  if (empty && pristine) return "empty";
  if (loaded) return "loaded";
  return "unsafe";
}

export function isCutoverChecksum(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/iu.test(value.trim());
}

/**
 * The tracked Wrangler files are an executable cutover state machine, not
 * permanent "first deploy" defaults. Every accepted stage preserves a single
 * writer and makes future deploys safe after the cutover too.
 */
export function classifyLocalCutoverConfig(input) {
  const appMode = typeof input.appMode === "string" ? input.appMode.trim().toLowerCase() : "";
  const appSync = typeof input.appSync === "string" ? input.appSync.trim().toLowerCase() : "";
  const paymentsBootstrap = typeof input.paymentsBootstrap === "string"
    ? input.paymentsBootstrap.trim().toLowerCase() : "";
  const paymentsChecksum = typeof input.paymentsChecksum === "string"
    ? input.paymentsChecksum.trim().toLowerCase() : "";
  const invalid = (reason) => ({ valid: false, stage: "invalid", reason });

  if (!["legacy", "frozen", "payments"].includes(appMode)) {
    return invalid("PAYMENTS_CUTOVER_MODE must be legacy, frozen or payments");
  }
  if (!["true", "false"].includes(appSync)) {
    return invalid("PAYMENTS_SYNC_ENABLED must be explicitly true or false");
  }
  if (!["true", "false"].includes(paymentsBootstrap)) {
    return invalid("PAYMENTS_BOOTSTRAP_MODE must be explicitly true or false");
  }
  const checksumPending = paymentsChecksum === "pending";
  const checksumReady = isCutoverChecksum(paymentsChecksum);
  if (!checksumPending && !checksumReady) {
    return invalid("PAYMENTS_DATA_CUTOVER_CHECKSUM must be pending or a SHA-256 checksum");
  }

  if (!input.targetConfigured) {
    return appMode === "legacy" && appSync === "false" &&
      paymentsBootstrap === "true" && checksumPending
      ? { valid: true, stage: "preprovision", reason: "Payments target is deliberately unprovisioned" }
      : invalid("An unprovisioned target only permits legacy, sync=false, bootstrap=true and checksum=pending");
  }

  if (paymentsBootstrap === "true") {
    if (appSync !== "false" || appMode === "payments") {
      return invalid("App sync/payments ownership cannot be enabled while Payments bootstrap is active");
    }
    if (appMode === "legacy" && checksumPending) {
      return { valid: true, stage: "bootstrap", reason: "Payments is dark while App owns writes" };
    }
    if (appMode === "frozen" && checksumPending) {
      return { valid: true, stage: "frozen", reason: "App is frozen before the final import proof" };
    }
    if (appMode === "frozen" && checksumReady) {
      return { valid: true, stage: "imported-bootstrap", reason: "Imported data is pinned while writes remain blocked" };
    }
    return invalid("A checksum can only be pinned after App is frozen");
  }

  if (!checksumReady) {
    return invalid("Disabling Payments bootstrap requires a pinned SHA-256 import checksum");
  }
  if (appMode === "frozen") {
    return appSync === "true"
      ? { valid: true, stage: "syncing", reason: "App is frozen while its boundary outbox drains" }
      : { valid: true, stage: "target-active", reason: "Payments is active while App writes remain frozen" };
  }
  if (appMode === "payments" && appSync === "true") {
    return { valid: true, stage: "cutover", reason: "Payments owns writes and App boundary sync remains enabled" };
  }
  return invalid("Active Payments requires App frozen or payments-owned with sync enabled");
}

export function requiresExactPaymentsBaseline(stage) {
  return stage !== "syncing" && stage !== "cutover";
}

const APP_DEAD_FIELDS = [
  "payment_reconcile_dead",
  "user_event_dead",
  "balance_refresh_failed",
  "balance_projection_drift",
  "indexer_registry_failed",
  "provider_subscription_failed",
  "reorg_replay_failed",
];

const APP_ACTIVE_FIELDS = [
  "payment_reconcile_active",
  "user_event_active",
  "balance_refresh_active",
  "account_operation_active",
  "indexer_registry_active",
  "provider_subscription_active",
  "reorg_replay_active",
];

export function classifyAppOperationalState(counts) {
  if (!counts) return { valid: false, dead: -1, active: -1 };
  const fields = [...APP_DEAD_FIELDS, ...APP_ACTIVE_FIELDS];
  if (fields.some((field) => !Number.isSafeInteger(counts[field]) || counts[field] < 0)) {
    return { valid: false, dead: -1, active: -1 };
  }
  return {
    valid: true,
    dead: APP_DEAD_FIELDS.reduce((total, field) => total + counts[field], 0),
    active: APP_ACTIVE_FIELDS.reduce((total, field) => total + counts[field], 0),
  };
}

const PAYMENT_DRAIN_FIELDS = [
  "payment_reconcile_active",
  "webhook_delivery_active",
];

export function classifyAppPaymentDrainState(counts) {
  if (!counts || PAYMENT_DRAIN_FIELDS.some((field) =>
    !Number.isSafeInteger(counts[field]) || counts[field] < 0)) {
    return { valid: false, active: -1 };
  }
  return {
    valid: true,
    active: PAYMENT_DRAIN_FIELDS.reduce((total, field) => total + counts[field], 0),
  };
}

export function assertQueueContract(input) {
  if (!input.sourceName || input.sourceName !== input.producerName ||
    !input.consumerNames.includes(input.sourceName)) {
    throw new Error(`${input.label} Queue source, producer and consumer names diverge`);
  }
  return input.sourceName;
}

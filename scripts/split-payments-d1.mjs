import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const root = resolve(import.meta.dirname, "..");
const paymentsMigrations = readdirSync(resolve(root, "payments-worker", "migrations"))
  .filter((name) => /^\d+_.+\.sql$/u.test(name))
  .sort((left, right) => left.localeCompare(right, "en"))
  .map((name) => ({ name, sql: readFileSync(resolve(root, "payments-worker", "migrations", name), "utf8") }));

function parseArgs(argv) {
  const options = { drill: false, source: null, sourceSql: null, target: null, backupDir: null,
    verifyTargetSql: null, manifest: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--drill") options.drill = true;
    else if (value === "--source") options.source = argv[++index];
    else if (value === "--source-sql") options.sourceSql = argv[++index];
    else if (value === "--target") options.target = argv[++index];
    else if (value === "--backup-dir") options.backupDir = argv[++index];
    else if (value === "--verify-target-sql") options.verifyTargetSql = argv[++index];
    else if (value === "--manifest") options.manifest = argv[++index];
    else throw new Error(`Unknown option ${value}`);
  }
  if (options.source && options.sourceSql) throw new Error("Use only one of --source or --source-sql");
  if (options.verifyTargetSql || options.manifest) {
    if (!options.verifyTargetSql || !options.manifest || options.drill || options.source || options.sourceSql || options.target) {
      throw new Error("Target verification requires only --verify-target-sql and --manifest");
    }
    return options;
  }
  if (!options.drill && ((!options.source && !options.sourceSql) || !options.target)) {
    throw new Error("Use --drill or provide --source/--source-sql and --target");
  }
  return options;
}

function table(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(name);
}

function columns(db, name) {
  if (!table(db, name)) return new Set();
  return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((row) => row.name));
}

function rows(db, sql, values = []) {
  return db.prepare(sql).all(...values);
}

function canonicalSqliteValue(value) {
  if (value === null || value === undefined) return ["null"];
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return ["blob", Buffer.from(value).toString("hex")];
  }
  if (typeof value === "number") return ["number", String(value)];
  if (typeof value === "bigint") return ["integer", value.toString()];
  if (typeof value === "string") return ["text", value];
  throw new Error(`Unsupported SQLite checksum value type: ${typeof value}`);
}

function contentChecksum(db, tableNames, webhookKeyring) {
  const canonical = {};
  for (const tableName of [...tableNames].sort()) {
    const tableInfo = rows(db, `PRAGMA table_info(${identifier(tableName)})`);
    const columnNames = tableInfo.map((column) => column.name);
    const primaryKey = tableInfo.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
    const orderBy = primaryKey.length
      ? primaryKey.map((column) => identifier(column.name)).join(", ")
      : "rowid";
    canonical[tableName] = {
      columns: columnNames,
      rows: rows(db, `SELECT * FROM ${identifier(tableName)} ORDER BY ${orderBy}`)
        .map((row) => columnNames.map((column) => {
          if (tableName === "webhook_endpoints" && column === "secret_ciphertext") {
            const plaintext = decryptImportedWebhookSecret(row.secret_ciphertext, row.secret_key_id, webhookKeyring);
            return ["webhook-secret-sha256", createHash("sha256").update(plaintext).digest("hex")];
          }
          if (tableName === "webhook_endpoints" && column === "secret_key_id") {
            return ["webhook-encryption-representation"];
          }
          return canonicalSqliteValue(row[column]);
        })),
    };
  }
  return createHash("sha256").update(JSON.stringify({ version: 2, tables: canonical })).digest("hex");
}

function atomic(value) {
	const text = String(value ?? "0").trim() || "0";
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(text)) throw new Error(`Invalid legacy USDC amount: ${text}`);
  const [whole, fraction = ""] = text.split(".");
  return (BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6))).toString();
}

function merchantId(uid) {
  return `mrc_${createHash("sha256").update(uid).digest("hex").slice(0, 32)}`;
}

function safeStatus(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function decodedEncryptionKey(encoded, label) {
  const key = /^[0-9a-fA-F]{64}$/u.test(encoded) ? Buffer.from(encoded, "hex") : Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error(`${label} must decode to 32 bytes`);
  return key;
}

function encryptionConfig({ allowGenerated }) {
	const configured = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY;
  const id = process.env.WEBHOOK_SECRET_ENCRYPTION_KEY_ID?.trim() || (allowGenerated ? "cutover-drill" : "");
	if (!configured && !allowGenerated) throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEY is required for a real cutover");
  if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(id)) {
    throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEY_ID is required for a real cutover and must be a valid key ID");
  }
  const active = { id, key: configured
    ? decodedEncryptionKey(configured, "WEBHOOK_SECRET_ENCRYPTION_KEY") : randomBytes(32) };
  const keyring = new Map([[active.id, active.key]]);
  const previousRaw = process.env.WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS?.trim();
  if (previousRaw) {
    let previous;
    try { previous = JSON.parse(previousRaw); }
    catch { throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS is malformed"); }
    if (!previous || typeof previous !== "object" || Array.isArray(previous) || Object.keys(previous).length > 16) {
      throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS is malformed");
    }
    for (const [keyId, value] of Object.entries(previous)) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(keyId) || typeof value !== "string" || !value) {
        throw new Error("WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS is invalid");
      }
      keyring.set(keyId, decodedEncryptionKey(value, `Webhook encryption key ${keyId}`));
    }
  }
  return { active, keyring };
}

function webhookAad(keyId) {
  return Buffer.from(`gatopago-webhook:${keyId}`, "utf8");
}

function encryptLegacySecret(secret, spec) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", spec.key, nonce);
  cipher.setAAD(webhookAad(spec.id));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `enc:v2:${spec.id}:${nonce.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptImportedWebhookSecret(ciphertext, storedKeyId, keyring) {
  if (typeof ciphertext !== "string" || typeof storedKeyId !== "string" || !keyring) {
    throw new Error("Webhook semantic checksum requires the configured encryption keyring");
  }
  const embedded = ciphertext.match(/^enc:v2:([A-Za-z0-9_.-]{1,64}):(.+)$/u);
  const keyId = embedded?.[1] ?? storedKeyId;
  if (keyId !== storedKeyId) throw new Error("Webhook ciphertext key ID mismatch during semantic verification");
  const key = keyring.get(keyId);
  if (!key) throw new Error(`Webhook encryption key ${keyId} is unavailable for semantic verification`);
  const [nonceEncoded, payloadEncoded] = (embedded?.[2] ?? ciphertext).split(".");
  if (!nonceEncoded || !payloadEncoded) throw new Error("Invalid webhook ciphertext during semantic verification");
  const nonce = Buffer.from(nonceEncoded, "base64");
  const payload = Buffer.from(payloadEncoded, "base64");
  if (nonce.length !== 12 || payload.length <= 16) throw new Error("Invalid webhook ciphertext length");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  if (embedded) decipher.setAAD(webhookAad(keyId));
  decipher.setAuthTag(payload.subarray(payload.length - 16));
  return Buffer.concat([decipher.update(payload.subarray(0, -16)), decipher.final()]).toString("utf8");
}

function insert(db, sql, values) {
  db.prepare(sql).run(...values);
}

function identifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function sqlValue(value) {
  if (value === null || value === undefined) return "NULL";
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot export a non-finite SQLite number");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error(`Cannot export unsafe SQLite integer ${value}; store it as TEXT before cutover`);
    }
    return String(value);
  }
  if (typeof value !== "string") throw new Error(`Unsupported SQLite value type: ${typeof value}`);
  if (value.includes("\0")) return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
  return `'${value.replaceAll("'", "''")}'`;
}

function ownedTables(db) {
  return rows(db, `SELECT name FROM sqlite_schema
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
      AND name NOT LIKE '_cf_%'
      AND name <> 'd1_migrations'
    ORDER BY name`).map((row) => row.name);
}

function insertionOrder(db, tableNames) {
  const known = new Set(tableNames);
  const dependencies = new Map(tableNames.map((name) => [name, new Set(
    rows(db, `PRAGMA foreign_key_list(${identifier(name)})`)
      .map((row) => row.table)
      .filter((parent) => known.has(parent) && parent !== name),
  )]));
  const emitted = new Set();
  const ordered = [];
  while (ordered.length < tableNames.length) {
    const ready = tableNames
      .filter((name) => !emitted.has(name) && [...dependencies.get(name)].every((parent) => emitted.has(parent)))
      .sort();
    if (!ready.length) {
      const blocked = tableNames.filter((name) => !emitted.has(name));
      throw new Error(`Cannot create a dependency-safe D1 data import order: ${blocked.join(", ")}`);
    }
    for (const name of ready) {
      emitted.add(name);
      ordered.push(name);
    }
  }
  return ordered;
}

function exportDataOnly(db, outputPath) {
  const tableNames = ownedTables(db);
  if (!tableNames.includes("payment_migration_control")) {
    throw new Error("payment_migration_control is required for a guarded Payments import");
  }
  const businessTables = tableNames.filter((name) => name !== "payment_migration_control");
  const guardExpression = businessTables.length
    ? businessTables.map((name) => `(SELECT COUNT(*) FROM ${identifier(name)})`).join(" + ")
    : "0";
  const fd = openSync(outputPath, "wx", 0o600);
  let rowCount = 0;
  let completed = false;
  const write = (value) => writeSync(fd, value, undefined, "utf8");
  try {
    write("-- GatoPago Payments data-only cutover artifact.\n");
    write("-- Apply payments-worker migrations with Wrangler before importing this file.\n");
    write("-- BEGIN/COMMIT are intentionally omitted because D1 wraps file imports.\n");
    write("CREATE TABLE \"_gatopago_import_guard_v1\" (\"must_be_zero\" INTEGER NOT NULL CHECK (\"must_be_zero\" = 0));\n");
    write(`INSERT INTO \"_gatopago_import_guard_v1\" SELECT ${guardExpression};\n`);
    write("INSERT INTO \"_gatopago_import_guard_v1\" SELECT CASE WHEN (SELECT COUNT(*) FROM \"payment_migration_control\" WHERE \"id\" = 1 AND \"legacy_copy_version\" = 0 AND \"legacy_copy_completed_at\" IS NULL) = 1 THEN 0 ELSE 1 END;\n");
    write("DROP TABLE \"_gatopago_import_guard_v1\";\n");
    write("DELETE FROM \"payment_migration_control\" WHERE \"id\" = 1 AND \"legacy_copy_version\" = 0 AND \"legacy_copy_completed_at\" IS NULL;\n");

    for (const tableName of insertionOrder(db, tableNames)) {
      const tableInfo = rows(db, `PRAGMA table_info(${identifier(tableName)})`);
      const columnNames = tableInfo.map((column) => column.name);
      const primaryKey = tableInfo.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
      const orderBy = primaryKey.length
        ? primaryKey.map((column) => identifier(column.name)).join(", ")
        : "rowid";
      const statement = db.prepare(`SELECT * FROM ${identifier(tableName)} ORDER BY ${orderBy}`);
      for (const row of statement.iterate()) {
        const values = columnNames.map((column) => sqlValue(row[column])).join(", ");
        write(`INSERT INTO ${identifier(tableName)} (${columnNames.map(identifier).join(", ")}) VALUES (${values});\n`);
        rowCount += 1;
      }
    }
    completed = true;
  } finally {
    closeSync(fd);
    if (!completed) rmSync(outputPath, { force: true });
  }
  const contents = readFileSync(outputPath);
  if (contents.includes(Buffer.from("d1_migrations", "utf8"))) {
    throw new Error("Data-only artifact must never modify Wrangler migration history");
  }
  return { rowCount, sha256: createHash("sha256").update(contents).digest("hex") };
}

function verifyDataOnlyImport(dataSqlPath, manifest, encryption) {
  const directory = resolve(tmpdir(), `gatopago-payments-import-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, "migrated-then-imported.sqlite");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA foreign_keys=ON");
    for (const migration of paymentsMigrations) db.exec(migration.sql);
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(dataSqlPath, "utf8"));
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    const verification = verify(db, manifest, encryption.keyring);

    let ciphertextRepresentationNormalized = true;
    const webhook = db.prepare("SELECT id, secret_ciphertext, secret_key_id FROM webhook_endpoints ORDER BY id LIMIT 1").get();
    if (webhook) {
      const plaintext = decryptImportedWebhookSecret(webhook.secret_ciphertext, webhook.secret_key_id, encryption.keyring);
      const alternateCiphertext = encryptLegacySecret(plaintext, encryption.active);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("UPDATE webhook_endpoints SET secret_ciphertext = ?, secret_key_id = ? WHERE id = ?")
          .run(alternateCiphertext, encryption.active.id, webhook.id);
        verify(db, manifest, encryption.keyring);
        db.exec("ROLLBACK");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    let contentTamperRejected = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("UPDATE merchants SET display_name = display_name || '#tampered' WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1)");
      try { verify(db, manifest, encryption.keyring); }
      catch { contentTamperRejected = true; }
      db.exec("ROLLBACK");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (!contentTamperRejected) throw new Error("Payments content checksum accepted a semantic row mutation");

    let replayRejected = false;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(readFileSync(dataSqlPath, "utf8"));
      db.exec("ROLLBACK");
    } catch {
      db.exec("ROLLBACK");
      replayRejected = true;
    }
    if (!replayRejected) throw new Error("Payments data-only artifact did not reject a non-empty/replayed import");
    return { ...verification, replayRejected: true, contentTamperRejected: true,
      ciphertextRepresentationNormalized };
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

function migrate(source, target, encryption) {
  for (const migration of paymentsMigrations) target.exec(migration.sql);
  const now = new Date().toISOString();
  const users = new Map(table(source, "users")
    ? rows(source, "SELECT uid, wallet_address, username FROM users").map((row) => [row.uid, row]) : []);
  const legacyLinks = table(source, "payment_links") ? rows(source, "SELECT * FROM payment_links ORDER BY id") : [];
  const legacyMerchants = table(source, "merchants") ? rows(source, "SELECT * FROM merchants ORDER BY id") : [];
  const appOwnedCrosschainRows = table(source, "crosschain_operations")
    ? rows(source, "SELECT COUNT(*) AS count FROM crosschain_operations")[0].count : 0;
  const ownerMerchant = new Map();
  const merchants = new Map();

  for (const row of legacyMerchants) {
    const user = users.get(row.owner_uid);
    const fallbackLink = legacyLinks.find((link) => link.owner_uid === row.owner_uid);
    const wallet = String(user?.wallet_address ?? fallbackLink?.wallet_address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/u.test(wallet)) {
      throw new Error(`Legacy merchant ${row.id} has no valid settlement wallet`);
    }
    const merchant = { id: row.id, ownerUid: row.owner_uid, name: row.name ?? user?.username ?? "", wallet,
      chainId: 421614, version: 1, createdAt: row.created_at ?? now, updatedAt: row.created_at ?? now };
    merchants.set(merchant.id, merchant);
    ownerMerchant.set(merchant.ownerUid, merchant.id);
  }
  for (const link of legacyLinks) {
    if (ownerMerchant.has(link.owner_uid)) continue;
    const wallet = String(link.wallet_address ?? users.get(link.owner_uid)?.wallet_address ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/u.test(wallet)) throw new Error(`Legacy link ${link.id} has no valid settlement wallet`);
    const merchant = { id: merchantId(link.owner_uid), ownerUid: link.owner_uid,
      name: users.get(link.owner_uid)?.username ?? "", wallet, chainId: 421614, version: 1,
      createdAt: link.created_at ?? now, updatedAt: link.created_at ?? now };
    merchants.set(merchant.id, merchant);
    ownerMerchant.set(merchant.ownerUid, merchant.id);
  }

  target.exec("BEGIN IMMEDIATE");
  try {
    for (const merchant of merchants.values()) insert(target,
      "INSERT INTO merchants(id, owner_uid, display_name, settlement_wallet, settlement_chain_id, account_version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)",
      [merchant.id, merchant.ownerUid, merchant.name ?? "", merchant.wallet, merchant.chainId, merchant.version, merchant.createdAt, merchant.updatedAt]);

    const legacyIntents = table(source, "payment_intents") ? rows(source, "SELECT * FROM payment_intents ORDER BY id") : [];
    const intentByLink = new Map(legacyIntents.filter((row) => row.link_id).map((row) => [row.link_id, row]));
    const expected = { merchants: [...merchants.keys()], payment_links: [], payment_intents: [], payment_quotes: [],
      payment_attempts: [], payment_fee_ledger: [], api_keys: [], webhook_endpoints: [], events: [],
      webhook_deliveries: [], crosschain_operations: [] };
    expected.merchants.sort();

    for (const link of legacyLinks) {
      const merchant = merchants.get(ownerMerchant.get(link.owner_uid));
      if (!merchant) throw new Error(`Merchant mapping missing for link ${link.id}`);
		const legacyIntent = intentByLink.get(link.id);
		const intentId = legacyIntent?.id ?? `legacy_pi_${link.id}`;
		const amountDecimal = String(legacyIntent?.amount ?? link.amount ?? "0").trim() || "0";
		const amountAtomic = atomic(amountDecimal);
		const amountMode = amountAtomic === "0" ? "payer_defined" : "fixed";
      const status = link.status === "paid" || legacyIntent?.status === "paid" ? "paid"
        : legacyIntent?.status === "canceled" ? "canceled" : legacyIntent?.status === "expired" ? "expired" : "awaiting_payment";
      insert(target,
		  "INSERT INTO payment_intents(id, merchant_id, link_id, idempotency_key, amount, amount_atomic, amount_mode, currency, reference, metadata, mode, status, settlement_wallet, settlement_chain_id, settlement_account_version, paid_amount_atomic, paid_tx_hash, paid_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'USDC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		  [intentId, merchant.id, link.id, legacyIntent?.idempotency_key ?? null, amountDecimal, amountAtomic, amountMode,
          legacyIntent?.reference ?? link.reference ?? "", legacyIntent?.metadata ?? "{}",
          safeStatus(legacyIntent?.mode, ["test", "live"], "test"), status,
			merchant.wallet, merchant.chainId, merchant.version, status === "paid" ? amountAtomic : "0",
          legacyIntent?.tx_hash ?? link.tx_hash ?? null, link.paid_at ?? null, legacyIntent?.expires_at ?? null,
          legacyIntent?.created_at ?? link.created_at ?? now, legacyIntent?.updated_at ?? link.created_at ?? now]);
      insert(target,
        "INSERT INTO payment_links(id, owner_uid, merchant_id, intent_id, wallet_address, amount, currency, reference, status, tx_hash, paid_at, paid_by, legacy_payment_claim, legacy_payment_claim_expires_at, legacy_payment_claim_tx_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'USDC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [link.id, link.owner_uid, merchant.id, intentId, merchant.wallet, amountDecimal, link.reference ?? "",
          status === "awaiting_payment" ? "pending" : status, link.tx_hash ?? null, link.paid_at ?? null,
          link.paid_by ?? null, link.payment_claim ?? null, link.payment_claim_expires_at ?? null,
          link.payment_claim_tx_hash ?? null, link.created_at ?? now, legacyIntent?.updated_at ?? link.created_at ?? now]);
      expected.payment_links.push(link.id);
      expected.payment_intents.push(intentId);
    }

    // API intents without a backing link receive a deterministic checkout link.
    for (const intent of legacyIntents.filter((row) => !row.link_id || !legacyLinks.some((link) => link.id === row.link_id))) {
      const merchant = merchants.get(intent.merchant_id);
      if (!merchant) throw new Error(`Legacy intent ${intent.id} references an unmigrated merchant`);
      const linkId = `legacy_link_${intent.id}`;
		const amountDecimal = String(intent.amount ?? "0").trim() || "0";
		const amountAtomic = atomic(amountDecimal);
		const amountMode = amountAtomic === "0" ? "payer_defined" : "fixed";
      const intentStatus = safeStatus(intent.status, ["awaiting_payment", "paid", "expired", "canceled"], "awaiting_payment");
      insert(target,
		  "INSERT INTO payment_intents(id, merchant_id, link_id, idempotency_key, amount, amount_atomic, amount_mode, currency, reference, metadata, mode, status, settlement_wallet, settlement_chain_id, settlement_account_version, paid_amount_atomic, paid_tx_hash, paid_at, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'USDC', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		  [intent.id, merchant.id, linkId, intent.idempotency_key ?? null, amountDecimal, amountAtomic, amountMode, intent.reference ?? "",
          intent.metadata ?? "{}", safeStatus(intent.mode, ["test", "live"], "test"), intentStatus,
          merchant.wallet, merchant.chainId, merchant.version,
			intentStatus === "paid" ? amountAtomic : "0", intent.tx_hash ?? null,
          intentStatus === "paid" ? intent.updated_at : null, intent.expires_at ?? null, intent.created_at, intent.updated_at]);
      insert(target,
        "INSERT INTO payment_links(id, owner_uid, merchant_id, intent_id, wallet_address, amount, currency, reference, status, tx_hash, paid_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'USDC', ?, ?, ?, ?, ?, ?)",
        [linkId, merchant.ownerUid, merchant.id, intent.id, merchant.wallet, amountDecimal, intent.reference ?? "",
          intentStatus === "awaiting_payment" ? "pending" : intentStatus, intent.tx_hash ?? null,
          intentStatus === "paid" ? intent.updated_at : null, intent.created_at, intent.updated_at]);
      expected.payment_intents.push(intent.id);
      expected.payment_links.push(linkId);
    }

    if (table(source, "api_keys")) for (const row of rows(source, "SELECT * FROM api_keys ORDER BY id")) {
      if (!merchants.has(row.merchant_id)) throw new Error(`Legacy API key ${row.id} references an unmigrated merchant`);
      insert(target, "INSERT INTO api_keys(id, merchant_id, mode, prefix, key_hash, name, last_used_at, revoked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [row.id, row.merchant_id, row.mode, row.key_prefix, row.secret_hash, row.name ?? "", row.last_used_at ?? null, row.revoked_at ?? null, row.created_at]);
      expected.api_keys.push(row.id);
    }
    if (table(source, "webhook_endpoints")) for (const row of rows(source, "SELECT * FROM webhook_endpoints ORDER BY id")) {
      if (!merchants.has(row.merchant_id)) throw new Error(`Legacy webhook endpoint ${row.id} references an unmigrated merchant`);
      insert(target, "INSERT INTO webhook_endpoints(id, merchant_id, url, secret_ciphertext, secret_key_id, mode, enabled_events, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [row.id, row.merchant_id, row.url, encryptLegacySecret(row.secret, encryption.active), encryption.active.id,
          safeStatus(row.mode, ["test", "live"], "test"), row.enabled_events ?? null,
          row.status === "enabled" ? "active" : "disabled", row.created_at, row.created_at]);
      expected.webhook_endpoints.push(row.id);
    }
    if (table(source, "events")) for (const row of rows(source, "SELECT * FROM events ORDER BY id")) {
      if (!merchants.has(row.merchant_id)) throw new Error(`Legacy event ${row.id} references an unmigrated merchant`);
      insert(target, "INSERT INTO events(id, merchant_id, type, object_id, dedupe_key, mode, payload, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)",
        [row.id, row.merchant_id, row.type, row.object_id ?? row.id,
          safeStatus(row.mode, ["test", "live"], "test"), row.payload, row.created_at]);
      expected.events.push(row.id);
    }
    if (table(source, "webhook_deliveries")) for (const row of rows(source, "SELECT * FROM webhook_deliveries ORDER BY id")) {
      if (!expected.events.includes(row.event_id) || !expected.webhook_endpoints.includes(row.endpoint_id)) {
        throw new Error(`Legacy webhook delivery ${row.id} references an unmigrated event or endpoint`);
      }
      const status = row.status === "delivered" ? "delivered" : row.status === "failed" ? "failed" : "pending";
      insert(target, "INSERT INTO webhook_deliveries(id, event_id, endpoint_id, status, attempt_count, next_retry_at, last_status_code, delivered_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [row.id, row.event_id, row.endpoint_id, status, row.attempt ?? 0, row.next_retry_at ?? now,
          row.response_code ?? null, row.delivered_at ?? null, row.created_at, row.delivered_at ?? row.created_at]);
      expected.webhook_deliveries.push(row.id);
    }

    for (const ids of Object.values(expected)) ids.sort();
    const sourceChecksum = contentChecksum(target, Object.keys(expected), encryption.keyring);
    insert(target, "UPDATE payment_migration_control SET legacy_copy_version = 1, legacy_copy_completed_at = ?, legacy_source_checksum = ?, legacy_target_checksum = ?, updated_at = ? WHERE id = 1",
      [now, sourceChecksum, sourceChecksum, now]);
    target.exec("COMMIT");
    return { expected, checksum: sourceChecksum, appOwnedCrosschainRows };
  } catch (error) {
    target.exec("ROLLBACK");
    throw error;
  }
}

function ids(db, tableName) {
  const key = tableName === "crosschain_operations" ? "op_id" : "id";
  return rows(db, `SELECT ${key} AS id FROM ${tableName} ORDER BY ${key}`).map((row) => row.id);
}

function verify(target, manifest, webhookKeyring) {
  const quick = target.prepare("PRAGMA quick_check").get();
  if (quick.quick_check !== "ok") throw new Error(`Payments quick_check failed: ${quick.quick_check}`);
  const foreign = target.prepare("PRAGMA foreign_key_check").all();
  if (foreign.length) throw new Error(`Payments foreign_key_check failed: ${JSON.stringify(foreign)}`);
  for (const required of ["payment_quotes", "payment_attempts", "payment_fee_ledger"]) {
    if (!table(target, required)) throw new Error(`Payments table missing after migrations: ${required}`);
  }
  const indexes = new Set(rows(target, "SELECT name FROM sqlite_schema WHERE type = 'index'").map((row) => row.name));
  for (const required of [
    "idx_intents_link_id",
    "idx_attempts_source_active_created",
    "idx_attempts_intent_created",
    "idx_payment_events_chain_canonical_height",
    "idx_rate_limits_window_start",
    "idx_payment_fee_ledger_status_created",
    "idx_attempts_submitted_expiry",
  ]) {
    if (!indexes.has(required)) throw new Error(`Payments scale index missing after migrations: ${required}`);
  }
  for (const required of ["fee_policy_id", "fee_policy_version", "platform_fee_bps", "route_fee_cap_bps"]) {
    if (!columns(target, "payment_attempts").has(required)) {
      throw new Error(`Payments economic column missing after migrations: payment_attempts.${required}`);
    }
  }
  for (const required of ["checkout_capability_hash", "payer_proof_signature", "payer_proof_message_hash"]) {
    if (!columns(target, "payment_attempts").has(required)) {
      throw new Error(`Payments checkout access column missing after migrations: payment_attempts.${required}`);
    }
  }
  for (const [tableName, expectedIds] of Object.entries(manifest.expected)) {
    const actual = ids(target, tableName);
    if (JSON.stringify(actual) !== JSON.stringify(expectedIds)) throw new Error(`${tableName} IDs/count mismatch`);
  }
  const checksum = contentChecksum(target, Object.keys(manifest.expected), webhookKeyring);
  if (checksum !== manifest.checksum) throw new Error("Payments cutover checksum mismatch");
  return { quickCheck: "ok", foreignKeyErrors: 0, checksum, checksumVersion: 2,
    counts: Object.fromEntries(Object.entries(manifest.expected).map(([name, values]) => [name, values.length])),
    ownership: { appOwnedCrosschainRows: manifest.appOwnedCrosschainRows,
      importedPersonalCrosschainRows: manifest.expected.crosschain_operations.length } };
}

function fixture(path) {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(uid TEXT PRIMARY KEY, username TEXT, wallet_address TEXT);
    CREATE TABLE payment_links(id TEXT PRIMARY KEY, owner_uid TEXT, wallet_address TEXT, amount TEXT, currency TEXT, reference TEXT, status TEXT, tx_hash TEXT, paid_at TEXT, paid_by TEXT, payment_claim TEXT, payment_claim_expires_at TEXT, payment_claim_tx_hash TEXT, created_at TEXT);
    CREATE TABLE merchants(id TEXT PRIMARY KEY, owner_uid TEXT, name TEXT, created_at TEXT);
    CREATE TABLE api_keys(id TEXT PRIMARY KEY, merchant_id TEXT, key_prefix TEXT, secret_hash TEXT, mode TEXT, name TEXT, last_used_at TEXT, revoked_at TEXT, created_at TEXT);
    CREATE TABLE payment_intents(id TEXT PRIMARY KEY, merchant_id TEXT, link_id TEXT, amount TEXT, currency TEXT, mode TEXT, status TEXT, metadata TEXT, reference TEXT, tx_hash TEXT, idempotency_key TEXT, expires_at TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE webhook_endpoints(id TEXT PRIMARY KEY, merchant_id TEXT, url TEXT, secret TEXT, mode TEXT, enabled_events TEXT, status TEXT, created_at TEXT);
    CREATE TABLE events(id TEXT PRIMARY KEY, merchant_id TEXT, type TEXT, object_id TEXT, mode TEXT, payload TEXT, created_at TEXT);
    CREATE TABLE webhook_deliveries(id TEXT PRIMARY KEY, event_id TEXT, endpoint_id TEXT, attempt INTEGER, status TEXT, response_code INTEGER, next_retry_at TEXT, delivered_at TEXT, created_at TEXT);
    CREATE TABLE crosschain_operations(op_id TEXT PRIMARY KEY, uid TEXT, cctp_mode TEXT, source_chain_id INTEGER, destination_chain_id INTEGER, source_tx_hash TEXT, destination_tx_hash TEXT, message_nonce TEXT, message_bytes TEXT, attestation TEXT, amount_in TEXT, cctp_fee_estimated TEXT, amount_out_expected TEXT, recipient TEXT, status TEXT, attempt_count INTEGER, last_error TEXT, created_at TEXT, updated_at TEXT, completed_at TEXT);
    INSERT INTO users VALUES ('u1','cat','0x00000000000000000000000000000000000000a1');
    INSERT INTO users VALUES ('u2','lynx','0x00000000000000000000000000000000000000c3');
    INSERT INTO merchants VALUES ('m1','u1','Cat''s café','2026-08-20T00:00:00.000Z');
    INSERT INTO payment_links VALUES ('link-existing','u1','0x00000000000000000000000000000000000000a1','10','USDC','Order 1','pending',NULL,NULL,NULL,NULL,NULL,NULL,'2026-08-20T00:00:00.000Z');
    INSERT INTO payment_links VALUES ('link-legacy','u1','0x00000000000000000000000000000000000000a1','12.5','USDC','Order 2','paid','0xabc','2026-08-21T00:00:00.000Z','0x00000000000000000000000000000000000000b2',NULL,NULL,NULL,'2026-08-20T00:00:00.000Z');
    INSERT INTO payment_intents VALUES ('pi-existing','m1','link-existing','10','USDC','test','awaiting_payment','{}','Order 1',NULL,'idem-1','2026-08-30T00:00:00.000Z','2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z');
    INSERT INTO api_keys VALUES ('key-1','m1','sk_test_example','0x1234','test','Default',NULL,NULL,'2026-08-20T00:00:00.000Z');
    INSERT INTO webhook_endpoints VALUES ('whe-1','m1','https://webhook.example/receive','whsec_legacy','test',NULL,'enabled','2026-08-20T00:00:00.000Z');
    INSERT INTO events VALUES ('evt-1','m1','payment.paid','pi-existing','test','{}','2026-08-20T00:00:00.000Z');
    INSERT INTO webhook_deliveries VALUES ('whd-1','evt-1','whe-1',0,'pending',NULL,'2026-08-20T00:00:00.000Z',NULL,'2026-08-20T00:00:00.000Z');
    INSERT INTO crosschain_operations VALUES ('op-1','u1','standard',84532,421614,'0xsource',NULL,'legacy-nonce','0x1234',NULL,'1000000','260','999740','0x00000000000000000000000000000000000000a1','waiting_attestation',1,NULL,'2026-08-20T00:00:00.000Z','2026-08-20T00:00:00.000Z',NULL);
    INSERT INTO crosschain_operations VALUES ('op-2','u2','fast',84532,421614,NULL,NULL,NULL,NULL,NULL,'2500000','650','2499350','0x00000000000000000000000000000000000000c3','pending_signature',0,NULL,'2026-08-21T00:00:00.000Z','2026-08-21T00:00:00.000Z',NULL);
    INSERT INTO crosschain_operations VALUES ('op-3','u1','standard',421614,84532,'0xburn','0xmint','legacy-nonce-3','0xabcd','0xbeef','5000000','650','4999350','0x00000000000000000000000000000000000000a1','completed',2,NULL,'2026-08-22T00:00:00.000Z','2026-08-22T00:10:00.000Z','2026-08-22T00:10:00.000Z');`);
  db.close();
}

function restoreCheck(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  const quick = db.prepare("PRAGMA quick_check").get().quick_check;
  db.close();
  if (quick !== "ok") throw new Error(`Restore check failed for ${basename(path)}`);
}

function materializeSql(sqlPath) {
  const sourceSql = resolve(sqlPath);
  if (!existsSync(sourceSql)) throw new Error(`Source App SQL export does not exist: ${sourceSql}`);
  const directory = mkdtempSync(resolve(tmpdir(), "gatopago-app-export-"));
  const sqlitePath = resolve(directory, "gatopago-app.sqlite");
  const db = new DatabaseSync(sqlitePath);
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    db.exec(readFileSync(sourceSql, "utf8"));
    const quick = db.prepare("PRAGMA quick_check").get().quick_check;
    if (quick !== "ok") throw new Error(`Materialized App export failed quick_check: ${quick}`);
  } finally {
    db.close();
  }
  return { directory, sqlitePath };
}

function execute(sourcePath, targetPath, backupDir, { allowGeneratedKey = false } = {}) {
  const source = resolve(sourcePath);
  const target = resolve(targetPath);
  if (!existsSync(source)) throw new Error(`Source App SQLite does not exist: ${source}`);
  if (existsSync(target)) throw new Error(`Refusing to overwrite Payments SQLite: ${target}`);
  mkdirSync(dirname(target), { recursive: true });
  const backups = resolve(backupDir);
  mkdirSync(backups, { recursive: true });
  const appBackup = resolve(backups, "gatopago-app-api.sqlite");
  const paymentsBackup = resolve(backups, "gatopago-payments-api.sqlite");
  const dataSql = resolve(backups, "gatopago-payments-data.sql");
  const manifestPath = resolve(backups, "split-manifest.json");
  if ([appBackup, paymentsBackup, dataSql, manifestPath].some(existsSync)) {
    throw new Error(`Refusing to overwrite backup/cutover files in ${backups}`);
  }

  const encryption = encryptionConfig({ allowGenerated: allowGeneratedKey });
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  const targetDb = new DatabaseSync(target);
  const manifest = migrate(sourceDb, targetDb, encryption);
  const verification = verify(targetDb, manifest, encryption.keyring);
  const dataArtifact = exportDataOnly(targetDb, dataSql);
  sourceDb.close();
  targetDb.close();
  const importVerification = verifyDataOnlyImport(dataSql, manifest, encryption);

  copyFileSync(source, appBackup, constants.COPYFILE_EXCL);
  copyFileSync(target, paymentsBackup, constants.COPYFILE_EXCL);
  restoreCheck(appBackup);
  restoreCheck(paymentsBackup);
  writeFileSync(manifestPath, `${JSON.stringify({
    version: 4,
    createdAt: new Date().toISOString(),
    migrations: paymentsMigrations.map((migration) => migration.name),
    expected: manifest.expected,
    appOwnedCrosschainRows: manifest.appOwnedCrosschainRows,
    semanticChecksum: {
      version: 2,
      encryptedWebhookNormalization: "decrypt-and-hash-plaintext",
    },
    verification,
    dataArtifact,
    importVerification,
  }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { verification, dataArtifact, dataSql, backups };
}

function verifyTargetExport(targetSqlPath, manifestPath) {
  const evidence = JSON.parse(readFileSync(resolve(manifestPath), "utf8"));
  if (evidence.version !== 4 || evidence.semanticChecksum?.version !== 2 ||
    !evidence.expected || !evidence.verification?.checksum) {
    throw new Error("Target verification requires a version 4 semantic split manifest");
  }
  const materialized = materializeSql(targetSqlPath);
  const encryption = encryptionConfig({ allowGenerated: false });
  const db = new DatabaseSync(materialized.sqlitePath, { readOnly: true });
  try {
    const verification = verify(db, {
      expected: evidence.expected,
      checksum: evidence.verification.checksum,
      appOwnedCrosschainRows: evidence.appOwnedCrosschainRows,
    }, encryption.keyring);
    return verification;
  } finally {
    db.close();
    rmSync(materialized.directory, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.verifyTargetSql) {
    const verification = verifyTargetExport(options.verifyTargetSql, options.manifest);
    console.log(`Payments target export semantic verification passed (${verification.checksum}, version ${verification.checksumVersion}).`);
    return;
  }
  if (!options.drill) {
    const backupDir = options.backupDir ? resolve(options.backupDir) : resolve(dirname(options.target), `split-backup-${Date.now()}`);
    let materialized = null;
    try {
      materialized = options.sourceSql ? materializeSql(options.sourceSql) : null;
      const result = execute(materialized?.sqlitePath ?? options.source, options.target, backupDir);
      console.log(`Payments D1 split verified: ${JSON.stringify(result.verification.counts)}`);
      console.log(`D1 data-only import verified (${result.dataArtifact.rowCount} rows): ${result.dataSql}`);
      console.log(`Independent restore copies: ${result.backups}`);
    } finally {
      if (materialized) rmSync(materialized.directory, { recursive: true, force: true });
    }
    return;
  }
  const directory = resolve(tmpdir(), `gatopago-payments-split-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const previousWebhookEnv = {
    key: process.env.WEBHOOK_SECRET_ENCRYPTION_KEY,
    id: process.env.WEBHOOK_SECRET_ENCRYPTION_KEY_ID,
    previous: process.env.WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS,
  };
  try {
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY = "22".repeat(32);
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEY_ID = "cutover-drill";
    process.env.WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS = "{}";
    const source = resolve(directory, "app.sqlite");
    const target = resolve(directory, "payments.sqlite");
    const backups = resolve(directory, "backups");
    fixture(source);
    const result = execute(source, target, backups);
    if (result.verification.ownership.appOwnedCrosschainRows !== 3 ||
      result.verification.ownership.importedPersonalCrosschainRows !== 0) {
      throw new Error("Personal cross-chain rows crossed the App/Payments ownership boundary");
    }
    const targetExport = resolve(directory, "payments-target-export.sql");
    const targetExportSql = `${paymentsMigrations.map((migration) => migration.sql).join("\n")}\n${readFileSync(result.dataSql, "utf8")}`;
    writeFileSync(targetExport, targetExportSql, { flag: "wx", mode: 0o600 });
    const manifestPath = resolve(backups, "split-manifest.json");
    verifyTargetExport(targetExport, manifestPath);
    const tamperedTargetExport = resolve(directory, "payments-target-tampered.sql");
    writeFileSync(tamperedTargetExport,
      `${targetExportSql}\nUPDATE merchants SET display_name = display_name || '#tampered' WHERE id = (SELECT id FROM merchants ORDER BY id LIMIT 1);\n`,
      { flag: "wx", mode: 0o600 });
    let targetTamperRejected = false;
    try { verifyTargetExport(tamperedTargetExport, manifestPath); }
    catch { targetTamperRejected = true; }
    if (!targetTamperRejected) throw new Error("Payments target export verifier accepted semantic tampering");
    console.log(`Payments D1 split drill passed (${result.verification.checksum}, data-only import + replay guard + both restores OK).`);
  } finally {
    for (const [name, value] of Object.entries({
      WEBHOOK_SECRET_ENCRYPTION_KEY: previousWebhookEnv.key,
      WEBHOOK_SECRET_ENCRYPTION_KEY_ID: previousWebhookEnv.id,
      WEBHOOK_SECRET_ENCRYPTION_KEYS_PREVIOUS: previousWebhookEnv.previous,
    })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

try { main(); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }

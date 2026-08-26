import { execFileSync } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const serverDir = resolve(rootDir, "server");
const remoteConfigPath = resolve(serverDir, "wrangler.jsonc");
const paymentsRemoteConfigPath = resolve(rootDir, "payments-worker", "wrangler.jsonc");
const migrationsDir = resolve(serverDir, "migrations");
const wranglerCli = resolve(serverDir, "node_modules", "wrangler", "bin", "wrangler.js");
const database = "GATOPAGO_DB";
const backupFormat = "GATOPAGO_D1_BACKUP_V1";
const legacyBackupFormat = "PARMELIA_D1_BACKUP_V1";
const magic = Buffer.from(`${backupFormat}\n`, "ascii");
const legacyMagic = Buffer.from(`${legacyBackupFormat}\n`, "ascii");
const nonceLength = 12;
const tagLength = 16;
const appRequiredTables = [
  "account_operations",
  "crosschain_operations",
  "events",
  "payment_links",
  "pending_payments",
  "users",
  "webhook_deliveries",
];
const paymentsRequiredTables = [
  "api_keys",
  "events",
  "merchants",
  "payment_attempts",
  "payment_intents",
  "payment_links",
  "payment_migration_control",
  "payment_quotes",
  "webhook_deliveries",
  "webhook_endpoints",
];
const fixtureSql = [
  "INSERT INTO users(uid, username) VALUES ('restore-drill-user', 'restore-drill-user')",
  "INSERT INTO passkeys(credential_id, uid, qx, qy) VALUES ('restore-drill-credential', 'restore-drill-user', 'qx', 'qy')",
].join(";");

function parseArgs(argv) {
  const parsed = { mode: undefined, input: undefined, output: undefined };
  const setMode = (mode) => {
    if (parsed.mode) throw new Error("Choose exactly one operation mode");
    parsed.mode = mode;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--remote") setMode("remote");
    else if (arg === "--remote-payments") setMode("remote-payments");
    else if (arg === "--drill") setMode("drill");
    else if (arg === "--verify") {
      setMode("verify");
      parsed.input = argv[++index];
    } else if (arg === "--decrypt") {
      setMode("decrypt");
      parsed.input = argv[++index];
    } else if (arg === "--output") parsed.output = argv[++index];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!parsed.mode) throw new Error("Choose --remote, --drill, --verify <file>, or --decrypt <file>");
  if ((parsed.mode === "verify" || parsed.mode === "decrypt") && !parsed.input) {
    throw new Error(`--${parsed.mode} requires an encrypted backup path`);
  }
  if (parsed.mode === "decrypt" && !parsed.output) throw new Error("--decrypt requires --output <file.sql>");
  if ((parsed.mode === "drill" || parsed.mode === "verify") && parsed.output) {
    throw new Error(`--output is not valid with --${parsed.mode}`);
  }
  return parsed;
}

function wrangler(args, { capture = false } = {}) {
  try {
    const output = execFileSync(process.execPath, [wranglerCli, ...args], {
      cwd: serverDir,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return capture ? output : undefined;
  } catch (error) {
    if (error && typeof error === "object") {
      if (typeof error.stdout === "string") process.stderr.write(error.stdout);
      if (typeof error.stderr === "string") process.stderr.write(error.stderr);
    }
    throw error;
  }
}

function localArgs(cwd) {
  return ["--local", "--config", join(cwd, "wrangler.jsonc")];
}

function writeDrillConfig(cwd) {
  const config = {
    name: "gatopago-d1-restore-drill",
    compatibility_date: "2026-07-14",
    d1_databases: [
      {
        binding: database,
        database_name: "gatopagodb-restore-drill",
        database_id: "00000000-0000-0000-0000-000000000001",
        migrations_dir: migrationsDir,
      },
    ],
  };
  writeFileSync(join(cwd, "wrangler.jsonc"), `${JSON.stringify(config, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function parseWranglerJson(output) {
  const start = output.indexOf("[");
  const objectStart = output.indexOf("{");
  const jsonStart = start === -1 ? objectStart : objectStart === -1 ? start : Math.min(start, objectStart);
  if (jsonStart === -1) throw new Error("Wrangler did not return JSON");
  return JSON.parse(output.slice(jsonStart));
}

function queryLocal(cwd, sql) {
  const output = wrangler(
    ["d1", "execute", database, ...localArgs(cwd), "--command", sql, "--json"],
    { capture: true },
  );
  const payload = parseWranglerJson(output);
  if (!Array.isArray(payload) || payload.length !== 1 || payload[0].success !== true) {
    throw new Error(`D1 query failed: ${JSON.stringify(payload)}`);
  }
  return payload[0].results;
}

function parseEncryptionKey(value) {
  if (!value) {
    throw new Error("D1_BACKUP_ENCRYPTION_KEY is required (32-byte hex or base64)");
  }
  const key = /^[0-9a-fA-F]{64}$/.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");
  if (key.length !== 32) {
    throw new Error("D1_BACKUP_ENCRYPTION_KEY must decode to exactly 32 bytes");
  }
  return key;
}

function hashingTransform(hash) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });
}

function hashingSink(hash) {
  return new Writable({
    write(chunk, _encoding, callback) {
      hash.update(chunk);
      callback();
    },
  });
}

async function sha256File(path) {
  const hash = createHash("sha256");
  // A Transform cannot safely be the final pipeline stage: its readable side
  // has no consumer and stalls once a backup exceeds the stream high-water
  // mark. A pure Writable drains every chunk while hashing it.
  await pipeline(createReadStream(path), hashingSink(hash));
  return hash.digest("hex");
}

async function encryptFile(source, destination, key) {
  if (existsSync(destination)) throw new Error(`Refusing to overwrite ${destination}`);
  const nonce = randomBytes(nonceLength);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, {
    authTagLength: tagLength,
  });
  const plaintextHash = createHash("sha256");

  writeFileSync(destination, Buffer.concat([magic, nonce]), { flag: "wx", mode: 0o600 });
  await pipeline(
    createReadStream(source),
    hashingTransform(plaintextHash),
    cipher,
    createWriteStream(destination, { flags: "a", mode: 0o600 }),
  );
  writeFileSync(destination, cipher.getAuthTag(), { flag: "a" });

  return {
    plaintextSha256: plaintextHash.digest("hex"),
    encryptedSha256: await sha256File(destination),
  };
}

async function decryptFile(source, destination, key, expected) {
  if (existsSync(destination)) throw new Error(`Refusing to overwrite ${destination}`);
  if ((await sha256File(source)) !== expected.encryptedSha256) {
    throw new Error("Encrypted backup checksum mismatch");
  }

  const file = await open(source, "r");
  try {
    const size = statSync(source).size;
    const header = Buffer.alloc(magic.length + nonceLength);
    const tag = Buffer.alloc(tagLength);
    await file.read(header, 0, header.length, 0);
    await file.read(tag, 0, tag.length, size - tagLength);
		const fileMagic = header.subarray(0, magic.length);
    if (!fileMagic.equals(magic) && !fileMagic.equals(legacyMagic)) {
      throw new Error("Unsupported D1 backup format");
    }

    const nonce = header.subarray(magic.length);
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
      authTagLength: tagLength,
    });
    decipher.setAuthTag(tag);
    const plaintextHash = createHash("sha256");
    await pipeline(
      createReadStream(source, {
        start: header.length,
        end: size - tagLength - 1,
      }),
      decipher,
      hashingTransform(plaintextHash),
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
    if (plaintextHash.digest("hex") !== expected.plaintextSha256) {
      throw new Error("Decrypted backup checksum mismatch");
    }
  } finally {
    await file.close();
  }
}

async function makeTempDir(label) {
  return mkdtemp(join(tmpdir(), `gatopago-d1-${label}-`));
}

async function removeTempDir(path) {
  const absolute = resolve(path);
  const tempRoot = resolve(tmpdir());
  if (!absolute.startsWith(`${tempRoot}${sep}`) || !basename(absolute).startsWith("gatopago-d1-")) {
    throw new Error(`Refusing to remove non-GatoPago temp path: ${absolute}`);
  }
  await rm(absolute, { recursive: true, force: true });
}

function assertSqlExport(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size === 0) throw new Error("D1 export is empty");
  const descriptor = openSync(path, "r");
  const buffer = Buffer.alloc(Math.min(stat.size, 64 * 1024));
  try {
    readSync(descriptor, buffer, 0, buffer.length, 0);
  } finally {
    closeSync(descriptor);
  }
  const prefix = buffer.toString("utf8");
  if (!prefix.includes("CREATE TABLE")) throw new Error("D1 export does not contain a schema");
}

async function verifyRestore(sqlPath, { expectFixture, requiredTables = appRequiredTables }) {
  const restoreDir = await makeTempDir("restore");
  try {
    writeDrillConfig(restoreDir);
    wrangler([
      "d1",
      "execute",
      database,
      ...localArgs(restoreDir),
      "--file",
      sqlPath,
      "--yes",
    ]);

    const quickCheck = queryLocal(restoreDir, "PRAGMA quick_check");
    if (quickCheck.length !== 1 || quickCheck[0].quick_check !== "ok") {
      throw new Error(`D1 quick_check failed: ${JSON.stringify(quickCheck)}`);
    }
    const foreignKeyErrors = queryLocal(restoreDir, "PRAGMA foreign_key_check");
    if (foreignKeyErrors.length !== 0) {
      throw new Error(`D1 foreign_key_check failed: ${JSON.stringify(foreignKeyErrors)}`);
    }

    const tables = new Set(
      queryLocal(
        restoreDir,
        "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name",
      ).map((row) => row.name),
    );
    const missing = requiredTables.filter((table) => !tables.has(table));
    if (missing.length > 0) throw new Error(`Restored D1 is missing tables: ${missing.join(", ")}`);

    if (expectFixture) {
      const rows = queryLocal(
        restoreDir,
        "SELECT COUNT(*) AS count FROM passkeys p JOIN users u ON u.uid = p.uid WHERE p.credential_id = 'restore-drill-credential'",
      );
      if (rows.length !== 1 || Number(rows[0].count) !== 1) {
        throw new Error("Restored D1 did not preserve the relational fixture");
      }
    }

    return { tableCount: tables.size, quickCheck: "ok", foreignKeyErrors: 0 };
  } finally {
    await removeTempDir(restoreDir);
  }
}

async function runDrill() {
  const sourceDir = await makeTempDir("source");
  const workDir = await makeTempDir("work");
  try {
    writeDrillConfig(sourceDir);
    wrangler(["d1", "migrations", "apply", database, ...localArgs(sourceDir)]);
    wrangler([
      "d1",
      "execute",
      database,
      ...localArgs(sourceDir),
      "--command",
      fixtureSql,
      "--yes",
    ]);

    const plaintext = join(workDir, "backup.sql");
    const encrypted = join(workDir, "backup.sql.enc");
    const decrypted = join(workDir, "restore.sql");
    wrangler(["d1", "export", database, ...localArgs(sourceDir), "--output", plaintext, "-y"]);
    assertSqlExport(plaintext);

    const key = randomBytes(32);
    const checksums = await encryptFile(plaintext, encrypted, key);
    writeFileSync(
      `${encrypted}.manifest.json`,
      `${JSON.stringify({
        format: backupFormat,
        encryptedFile: basename(encrypted),
        encryptedBytes: statSync(encrypted).size,
        keyId: "restore-drill",
        ...checksums,
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    await decryptFile(encrypted, decrypted, key, loadManifest(encrypted));
    const verification = await verifyRestore(decrypted, { expectFixture: true });
    console.log(
      `D1 backup/restore drill passed (${verification.tableCount} tables, integrity and FK checks OK).`,
    );
  } finally {
    await removeTempDir(sourceDir);
    await removeTempDir(workDir);
  }
}

async function runRemoteBackup(outputArg, profile = "app") {
  const remote = profile === "payments"
    ? { binding: "PAYMENTS_DB", configPath: paymentsRemoteConfigPath, requiredTables: paymentsRequiredTables }
    : { binding: database, configPath: remoteConfigPath, requiredTables: appRequiredTables };
  const key = parseEncryptionKey(process.env.D1_BACKUP_ENCRYPTION_KEY);
  const keyId = process.env.D1_BACKUP_ENCRYPTION_KEY_ID;
  if (!keyId || !/^[A-Za-z0-9._-]{1,64}$/.test(keyId)) {
    throw new Error("D1_BACKUP_ENCRYPTION_KEY_ID is required and must be a short safe identifier");
  }
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const output = outputArg
    ? resolve(rootDir, outputArg)
    : resolve(rootDir, "backups", `gatopagodb-${timestamp}.sql.enc`);
  if (!isAbsolute(output)) throw new Error("Backup output must resolve to an absolute path");
  if (!output.endsWith(".sql.enc")) throw new Error("Backup output must end in .sql.enc");
  if (existsSync(output) || existsSync(`${output}.manifest.json`)) {
    throw new Error(`Refusing to overwrite an existing backup: ${output}`);
  }
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });

  const workDir = await makeTempDir("remote");
  let complete = false;
  try {
    const plaintext = join(workDir, "remote.sql");
    const bookmarkOutput = wrangler(
      ["d1", "time-travel", "info", remote.binding, "--config", remote.configPath, "--json"],
      { capture: true },
    );
    const timeTravel = parseWranglerJson(bookmarkOutput);

    wrangler([
      "d1",
      "export",
      remote.binding,
      "--remote",
      "--config",
      remote.configPath,
      "--output",
      plaintext,
      "-y",
    ]);
    assertSqlExport(plaintext);
    const checksums = await encryptFile(plaintext, output, key);

    const decrypted = join(workDir, "restore.sql");
    await decryptFile(output, decrypted, key, checksums);
    const verification = await verifyRestore(decrypted, {
      expectFixture: false,
      requiredTables: remote.requiredTables,
    });
    const manifest = {
      format: backupFormat,
      database: remote.binding,
      profile,
      exportedAt: new Date().toISOString(),
      encryptedFile: basename(output),
      encryptedBytes: statSync(output).size,
      keyId,
      ...checksums,
      timeTravel,
      verification,
    };
    writeFileSync(`${output}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    complete = true;
    console.log(`Encrypted D1 backup verified: ${output}`);
    console.log(`Manifest: ${output}.manifest.json`);
  } finally {
    if (!complete) {
      await rm(output, { force: true });
      await rm(`${output}.manifest.json`, { force: true });
    }
    await removeTempDir(workDir);
  }
}

function loadManifest(encryptedPath) {
  const manifestPath = `${encryptedPath}.manifest.json`;
  if (!existsSync(manifestPath)) throw new Error(`Backup manifest not found: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    ![backupFormat, legacyBackupFormat].includes(manifest.format) ||
    manifest.encryptedFile !== basename(encryptedPath) ||
    manifest.encryptedBytes !== statSync(encryptedPath).size ||
    typeof manifest.keyId !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(manifest.keyId) ||
    !/^[0-9a-f]{64}$/.test(manifest.plaintextSha256) ||
    !/^[0-9a-f]{64}$/.test(manifest.encryptedSha256)
  ) {
    throw new Error("Backup manifest is invalid or does not match the encrypted file");
  }
  return manifest;
}

async function verifyExistingBackup(inputArg, outputArg) {
  const input = resolve(rootDir, inputArg);
  const manifest = loadManifest(input);
  const key = parseEncryptionKey(process.env.D1_BACKUP_ENCRYPTION_KEY);
  const workDir = await makeTempDir("verify");
  try {
    const decrypted = outputArg ? resolve(rootDir, outputArg) : join(workDir, "restore.sql");
    if (outputArg && !decrypted.endsWith(".sql")) {
      throw new Error("Decrypted backup output must end in .sql");
    }
    await decryptFile(input, decrypted, key, manifest);
    const requiredTables = manifest.profile === "payments" || manifest.database === "PAYMENTS_DB"
      ? paymentsRequiredTables
      : appRequiredTables;
    const verification = await verifyRestore(decrypted, { expectFixture: false, requiredTables });
    console.log(
      `Encrypted D1 backup verified (${verification.tableCount} tables, integrity and FK checks OK).`,
    );
    if (outputArg) {
      console.log(`Plaintext recovery SQL written to ${decrypted}; protect and delete it after use.`);
    }
  } finally {
    await removeTempDir(workDir);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.mode === "drill") await runDrill();
  else if (options.mode === "remote") await runRemoteBackup(options.output);
  else if (options.mode === "remote-payments") await runRemoteBackup(options.output, "payments");
  else await verifyExistingBackup(options.input, options.mode === "decrypt" ? options.output : undefined);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

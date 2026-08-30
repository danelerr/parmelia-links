import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	APP_D1_SECURITY_EVIDENCE_QUERY,
	appliedMigrationNamesFromEvidence,
	assertPasskeySecuritySchemaEvidence,
	d1EvidenceRows,
} from "./app-d1-security-evidence.mjs";

const root = resolve(import.meta.dirname, "..");
const serverDirectory = resolve(root, "server");
const migrationsDirectory = resolve(serverDirectory, "migrations");
const wranglerCli = resolve(serverDirectory, "node_modules", "wrangler", "bin", "wrangler.js");
const databaseBinding = "GATOPAGO_DB";

function clean(output) {
	return String(output ?? "").replaceAll(/\u001b\[[0-9;]*m/gu, "").trim();
}

export function parseD1JsonOutput(output) {
	const cleaned = clean(output);
	const candidates = [...cleaned.matchAll(/[\[{]/gu)].map((match) => match.index ?? -1);
	for (const start of candidates) {
		try {
			return JSON.parse(cleaned.slice(start));
		} catch {
			// Wrangler may print a banner before its JSON payload. Try the next
			// structural character and fail closed if none is valid JSON.
		}
	}
	throw new Error("Refusing App deployment: Wrangler did not return valid D1 JSON.");
}

export function pendingAppMigrations(localNames, appliedNames) {
	if (!Array.isArray(localNames) || !Array.isArray(appliedNames)) {
		throw new TypeError("Migration inventories must be arrays");
	}
	const applied = new Set(appliedNames);
	return [...new Set(localNames)].sort().filter((name) => !applied.has(name));
}

export function assertNoPendingAppMigrations(localNames, appliedNames) {
	if (localNames.length === 0) {
		throw new Error("Refusing App deployment: no local App migrations were discovered.");
	}
	const pending = pendingAppMigrations(localNames, appliedNames);
	if (pending.length > 0) {
		throw new Error(
			`Refusing App deployment: remote ${databaseBinding} still has pending local migrations: ${pending.join(", ")}.`,
		);
	}
	return { applied: new Set(appliedNames).size, local: new Set(localNames).size };
}

function localMigrationNames() {
	return readdirSync(migrationsDirectory, { withFileTypes: true })
		.filter((entry) => entry.isFile() && /^\d{4}_[a-z0-9_]+\.sql$/u.test(entry.name))
		.map((entry) => entry.name)
		.sort();
}

function remoteAppD1EvidenceRows() {
	// process.execPath and every argument are fixed local values; no shell or
	// caller-controlled input participates in this read-only command.
	// nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
	const result = spawnSync(process.execPath, [
		wranglerCli,
		"d1", "execute", databaseBinding,
		"--remote", "--json", "--command", APP_D1_SECURITY_EVIDENCE_QUERY,
	], {
		cwd: serverDirectory,
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 8 * 1024 * 1024,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		throw new Error(
			`Refusing App deployment: remote migration inventory failed: ${clean(result.stderr) || clean(result.stdout) || `exit ${result.status}`}`,
		);
	}
	const payload = parseD1JsonOutput(result.stdout);
	return d1EvidenceRows(payload);
}

export function assertAppRemoteMigrations() {
	const evidence = remoteAppD1EvidenceRows();
	const migrationResult = assertNoPendingAppMigrations(
		localMigrationNames(),
		appliedMigrationNamesFromEvidence(evidence),
	);
	const schemaResult = assertPasskeySecuritySchemaEvidence(evidence);
	return { ...migrationResult, ...schemaResult };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const result = assertAppRemoteMigrations();
		console.log(
			`App remote migration guard passed: ${result.local} local migrations and ${result.schemaEvidence} security schema items are applied.`,
		);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertAppDeployConfig } from "./assert-app-deploy-config.mjs";
import { assertAppRemoteMigrations } from "./assert-app-remote-migrations.mjs";
import { assertAppRemoteSecrets } from "./assert-app-remote-secrets.mjs";
import { assertReproducibleDeploySource } from "./assert-reproducible-deploy-source.mjs";

const root = resolve(import.meta.dirname, "..");
const serverDirectory = resolve(root, "server");
const wranglerCli = resolve(serverDirectory, "node_modules", "wrangler", "bin", "wrangler.js");

function reject(message) {
	throw new Error(`Refusing App Worker deployment: ${message}`);
}

export function validateAppDeployArguments(args) {
	if (args.includes("--")) {
		reject("a literal -- separator reached the deploy script. Pass Wrangler flags directly after `run deploy`.");
	}

	if (args.length === 1 && args[0] === "--dry-run") {
		return { mode: "dry-run", wranglerArguments: ["--dry-run"] };
	}
	if (args.includes("--dry-run")) {
		reject("--dry-run cannot be combined with publication arguments.");
	}

	let keepVars = 0;
	let strict = 0;
	let message;
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === "--keep-vars") {
			keepVars += 1;
			continue;
		}
		if (argument === "--strict") {
			strict += 1;
			continue;
		}
		if (argument === "--message") {
			if (message !== undefined) reject("--message may be supplied only once.");
			const value = args[index + 1];
			if (!value || value.startsWith("--")) reject("--message requires a non-empty release description.");
			message = value;
			index += 1;
			continue;
		}
		reject(`unsupported argument ${JSON.stringify(argument)}.`);
	}

	if (keepVars !== 1 || strict !== 1 || !message || args.length !== 4) {
		reject("publication requires exactly --keep-vars, --strict and --message <description>.");
	}
	return { mode: "publish", wranglerArguments: [...args] };
}

function deploy(args) {
	const validated = validateAppDeployArguments(args);
	const commit = assertReproducibleDeploySource(["server"]);
	assertAppDeployConfig();
	const migrations = assertAppRemoteMigrations();
	const secrets = assertAppRemoteSecrets();
	process.stdout.write(
		`App deploy guards passed at ${commit}: ${migrations.local} migrations, ` +
		`${migrations.schemaEvidence} passkey schema items, ${migrations.multichainSchemaEvidence} multichain schema items and ${secrets.required.length} required secrets verified.\n`,
	);

	execFileSync(process.execPath, [wranglerCli, "deploy", "--minify", ...validated.wranglerArguments], {
		cwd: serverDirectory,
		stdio: "inherit",
	});
}

function drill() {
	const accepted = [
		["--dry-run"],
		["--keep-vars", "--strict", "--message", "phase3 release abc123"],
		["--message", "phase3 release abc123", "--strict", "--keep-vars"],
	];
	for (const args of accepted) validateAppDeployArguments(args);

	const rejected = [
		[],
		["--"],
		["--", "--dry-run"],
		["--dry-run", "--keep-vars", "--strict", "--message", "bad"],
		["--keep-vars", "--strict"],
		["--keep-vars", "--strict", "--message"],
		["--keep-vars", "--strict", "--message", ""],
		["--keep-vars", "--strict", "--message", "release", "--unknown"],
		["--keep-vars", "--keep-vars", "--strict", "--message", "release"],
	];
	for (const args of rejected) {
		let wasRejected = false;
		try { validateAppDeployArguments(args); } catch { wasRejected = true; }
		if (!wasRejected) throw new Error(`Unsafe App deploy fixture was accepted: ${JSON.stringify(args)}`);
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const args = process.argv.slice(2);
		if (args.length === 1 && args[0] === "--drill") {
			drill();
			process.stdout.write("App Worker deploy argument guard drill passed.\n");
		} else {
			deploy(args);
		}
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	}
}

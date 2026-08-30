import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const defaultConfigPath = resolve(root, "server", "wrangler.jsonc");

export function requiredAppSecretNames(appConfig) {
	void appConfig;
	return [
		"AUTH_CODE_PEPPER",
		"FIREBASE_SERVICE_ACCOUNT",
		"FIREBASE_WEB_API_KEY",
		"OPS_HEALTH_TOKEN",
		"PRIVATE_KEY",
		"RPC_URL",
		"TURNSTILE_SECRET_KEY",
	];
}

export function missingAppSecretNames(appConfig, remoteNames) {
	const configured = new Set(remoteNames);
	return requiredAppSecretNames(appConfig).filter((name) => !configured.has(name));
}

export function assertAppRemoteSecrets(configPath = defaultConfigPath) {
	const appConfig = readFileSync(configPath, "utf8");
	const wranglerCli = resolve(root, "server", "node_modules", "wrangler", "bin", "wrangler.js");
	const result = spawnSync(process.execPath, [
		wranglerCli,
		"secret",
		"list",
		"--name",
		"server",
		"--format",
		"json",
	], {
		cwd: resolve(root, "server"),
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 4 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		throw new Error("Refusing App deployment: cannot verify remote App secret names.");
	}
	let entries;
	try {
		entries = JSON.parse(result.stdout);
	} catch {
		throw new Error("Refusing App deployment: Wrangler returned an invalid secret inventory.");
	}
	const names = Array.isArray(entries)
		? entries.map((entry) => entry?.name).filter((name) => typeof name === "string")
		: [];
	const missing = missingAppSecretNames(appConfig, names);
	if (missing.length > 0) {
		throw new Error(`Refusing App deployment: missing remote App secrets: ${missing.join(", ")}.`);
	}
	return { checked: names.length, required: requiredAppSecretNames(appConfig) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		assertAppRemoteSecrets();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	}
}

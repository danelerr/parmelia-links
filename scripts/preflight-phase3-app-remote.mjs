import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	APP_D1_SECURITY_EVIDENCE_QUERY,
	appliedMigrationNamesFromEvidence,
	d1EvidenceRows,
	missingPasskeySecuritySchemaEvidence,
} from "./app-d1-security-evidence.mjs";

const root = resolve(import.meta.dirname, "..");
const serverDirectory = resolve(root, "server");
const serverConfig = readFileSync(resolve(serverDirectory, "wrangler.jsonc"), "utf8");
const wranglerCli = resolve(serverDirectory, "node_modules", "wrangler", "bin", "wrangler.js");
const expectedMigrations = [
	"0035_firebase_email_links.sql",
	"0036_passkey_security_metadata.sql",
	"0037_webauthn_authentication.sql",
];
const expectedFirebaseProject = "proyecto-prueba-push-firebase";
const checks = [];
const allowedCommands = new Set([process.execPath, "gcloud", "pwsh.exe"]);

function configValue(pattern, label) {
	const match = serverConfig.match(pattern);
	if (!match) throw new Error(`Cannot read ${label} from server/wrangler.jsonc`);
	return match[1];
}

const workerName = configValue(/"name"\s*:\s*"([^"]+)"/u, "Worker name");
const appUrl = configValue(/"APP_URL"\s*:\s*"([^"]+)"/u, "APP_URL");
const passkeyRpId = configValue(/"PASSKEY_RP_ID"\s*:\s*"([^"]+)"/u, "PASSKEY_RP_ID");
const passkeyAllowedOrigins = configValue(
	/"PASSKEY_ALLOWED_ORIGINS"\s*:\s*"([^"]+)"/u,
	"PASSKEY_ALLOWED_ORIGINS",
);
const firebaseProject = configValue(/"FIREBASE_PROJECT_ID"\s*:\s*"([^"]+)"/u, "Firebase project");
const workersSubdomain = process.env.CLOUDFLARE_WORKERS_SUBDOMAIN?.trim() || "parmelia";
const workerUrl = `https://${workerName}.${workersSubdomain}.workers.dev`;

function clean(output) {
	return String(output ?? "").replaceAll(/\u001b\[[0-9;]*m/gu, "").trim();
}

function run(command, args, { cwd = root, allowFailure = false } = {}) {
	if (!allowedCommands.has(command)) {
		throw new Error(`Refusing to execute a non-allowlisted command: ${command}`);
	}
	if (!Array.isArray(args) || args.some((argument) => typeof argument !== "string")) {
		throw new TypeError("Command arguments must be an array of strings");
	}
	// The executable is allowlisted above, arguments are internal values, and no
	// shell is involved. Semgrep cannot infer that constraint through this helper.
	// nosemgrep: javascript.lang.security.detect-child-process.detect-child-process
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 8 * 1024 * 1024,
	});
	const stdout = clean(result.stdout);
	const stderr = clean(result.stderr);
	if (result.error && !allowFailure) throw result.error;
	if (result.status !== 0 && !allowFailure) {
		throw new Error(stderr || stdout || `${command} exited ${result.status}`);
	}
	return { ok: !result.error && result.status === 0, stdout, stderr };
}

function runWrangler(args, options) {
	return run(process.execPath, [wranglerCli, ...args], { cwd: serverDirectory, ...options });
}

function parseJsonOutput(output) {
	const array = output.indexOf("[");
	const object = output.indexOf("{");
	const start = [array, object].filter((index) => index >= 0).sort((left, right) => left - right)[0];
	if (start === undefined) throw new Error("Command did not return JSON");
	return JSON.parse(output.slice(start));
}

function record(id, ok, detail) {
	checks.push({ id, status: ok ? "ready" : "pending", detail });
}

function bindingValue(version, name) {
	const binding = version?.resources?.bindings?.find((entry) =>
		entry?.name === name && entry?.type === "plain_text");
	return typeof binding?.text === "string" ? binding.text : null;
}

function cspSources(policy, directive) {
	if (!policy) return [];
	const entry = policy
		.split(";")
		.map((value) => value.trim())
		.find((value) => value === directive || value.startsWith(`${directive} `));
	return entry?.split(/\s+/u).slice(1) ?? [];
}

async function getJson(url, init = {}) {
	try {
		const response = await fetch(url, {
			...init,
			signal: AbortSignal.timeout(15_000),
		});
		const body = await response.json().catch(() => null);
		return { ok: response.ok, status: response.status, body };
	} catch (error) {
		return {
			ok: false,
			status: 0,
			body: null,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function firebaseAccessToken() {
	let command = "gcloud";
	let args = ["auth", "print-access-token", "--quiet"];
	if (process.platform === "win32") {
		const wrapper = resolve(
			process.env.LOCALAPPDATA ?? "",
			"Google",
			"Cloud SDK",
			"google-cloud-sdk",
			"bin",
			"gcloud.ps1",
		);
		if (!existsSync(wrapper)) return null;
		command = "pwsh.exe";
		args = [
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-File",
			wrapper,
			...args,
		];
	}
	const result = run(command, args, { allowFailure: true });
	return result.ok && result.stdout ? result.stdout : null;
}

async function main() {
	const flags = new Set(process.argv.slice(2));
	for (const flag of flags) {
		if (flag !== "--json") throw new Error(`Unknown option ${flag}`);
	}

	const source = run(process.execPath, [
		resolve(root, "scripts", "assert-reproducible-deploy-source.mjs"),
		"server",
		"client",
	], { allowFailure: true });
	record(
		"published-source",
		source.ok,
		source.ok ? source.stdout : "App source is not yet a clean published commit",
	);

	const secretResult = runWrangler([
		"secret", "list", "--name", workerName, "--format", "json",
	], { allowFailure: true });
	let secretNames = [];
	if (secretResult.ok) {
		try {
			secretNames = parseJsonOutput(secretResult.stdout)
				.map((entry) => entry?.name)
				.filter((name) => typeof name === "string");
		} catch {
			secretNames = [];
		}
	}
	const requiredSecrets = [
		"AUTH_CODE_PEPPER",
		"FIREBASE_SERVICE_ACCOUNT",
		"FIREBASE_WEB_API_KEY",
		"OPS_HEALTH_TOKEN",
		"PRIVATE_KEY",
		"RPC_URL",
		"TURNSTILE_SECRET_KEY",
	];
	const missingSecrets = requiredSecrets.filter((name) => !secretNames.includes(name));
	record(
		"app-secret-names",
		missingSecrets.length === 0,
		missingSecrets.length === 0
			? "All required App secret names exist; values were not read"
			: `Missing App secret names: ${missingSecrets.join(", ")}`,
	);

	const migrationResult = runWrangler([
		"d1", "execute", "GATOPAGO_DB", "--remote", "--json", "--command",
		APP_D1_SECURITY_EVIDENCE_QUERY,
	], { allowFailure: true });
	const appliedMigrations = new Set();
	let d1Evidence = [];
	if (migrationResult.ok) {
		try {
			const payload = parseJsonOutput(migrationResult.stdout);
			d1Evidence = d1EvidenceRows(payload);
			for (const name of appliedMigrationNamesFromEvidence(d1Evidence)) appliedMigrations.add(name);
		} catch {
			appliedMigrations.clear();
			d1Evidence = [];
		}
	}
	for (const migration of expectedMigrations) {
		const applied = appliedMigrations.has(migration);
		record(
			`app-migration-${migration.slice(0, 4)}`,
			applied,
			applied ? `${migration} is applied` : `${migration} is still pending`,
		);
	}
	const missingPasskeySchema = missingPasskeySecuritySchemaEvidence(d1Evidence);
	record(
		"app-passkey-schema-0037",
		missingPasskeySchema.length === 0,
		missingPasskeySchema.length === 0
			? "Passkey Security schema through 0037 is present"
			: `Passkey Security schema through 0037 is missing: ${missingPasskeySchema.join(", ")}`,
	);

	const deploymentResult = runWrangler([
		"deployments", "status", "--name", workerName, "--json",
	], { allowFailure: true });
	let activeVersions = [];
	if (deploymentResult.ok) {
		try {
			const deployment = parseJsonOutput(deploymentResult.stdout);
			activeVersions = (deployment?.versions ?? []).filter((version) =>
				typeof version?.version_id === "string" && Number(version?.percentage) > 0);
		} catch {
			activeVersions = [];
		}
	}
	let passkeyBindingsReady = activeVersions.length > 0;
	const passkeyBindingFailures = [];
	for (const activeVersion of activeVersions) {
		const versionResult = runWrangler([
			"versions", "view", activeVersion.version_id,
			"--name", workerName, "--json",
		], { allowFailure: true });
		if (!versionResult.ok) {
			passkeyBindingsReady = false;
			passkeyBindingFailures.push(`${activeVersion.version_id}: unreadable`);
			continue;
		}
		try {
			const version = parseJsonOutput(versionResult.stdout);
			const rpMatches = bindingValue(version, "PASSKEY_RP_ID") === passkeyRpId;
			const originsMatch = bindingValue(version, "PASSKEY_ALLOWED_ORIGINS") === passkeyAllowedOrigins;
			if (!rpMatches || !originsMatch) {
				passkeyBindingsReady = false;
				passkeyBindingFailures.push(
					`${activeVersion.version_id}: ${!rpMatches ? "RP ID" : ""}${!rpMatches && !originsMatch ? " and " : ""}${!originsMatch ? "origins" : ""} mismatch`,
				);
			}
		} catch {
			passkeyBindingsReady = false;
			passkeyBindingFailures.push(`${activeVersion.version_id}: invalid version JSON`);
		}
	}
	record(
		"app-webauthn-bindings",
		passkeyBindingsReady,
		passkeyBindingsReady
			? `Every active App Worker version uses RP ${passkeyRpId} and ${passkeyAllowedOrigins}`
			: passkeyBindingFailures.length > 0
				? `Active App Worker WebAuthn bindings are not ready: ${passkeyBindingFailures.join("; ")}`
				: "No active App Worker version could be verified",
	);

	const [live, health, appSurface, routeProof] = await Promise.all([
		getJson(`${workerUrl}/health/live`, { headers: { Accept: "application/json" } }),
		getJson(`${workerUrl}/health`, { headers: { Accept: "application/json" } }),
		fetch(appUrl, { redirect: "manual", signal: AbortSignal.timeout(15_000) })
			.then(async (response) => {
				await response.body?.cancel();
				return {
					status: response.status,
					location: response.headers.get("location"),
					contentSecurityPolicy: response.headers.get("content-security-policy"),
				};
			})
			.catch((error) => ({
				status: 0,
				location: null,
				contentSecurityPolicy: null,
				error: String(error),
			})),
		getJson(`${workerUrl}/auth/email-link/request`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: appUrl },
			// This value is rejected before Turnstile, rate limits or email delivery.
			body: JSON.stringify({ email: "invalid" }),
		}),
	]);
	record(
		"app-worker-health",
		live.ok && live.body?.status === "ok" && health.ok && health.body?.status === "ok",
		live.ok && health.ok
			? `App Worker is healthy with ${health.body?.warningCount ?? "unknown"} warnings`
			: `App Worker health failed (live ${live.status}, readiness ${health.status})`,
	);
	const externalRedirect = Boolean(
		appSurface.location && new URL(appSurface.location, appUrl).origin !== new URL(appUrl).origin,
	);
	record(
		"app-web-public",
		appSurface.status >= 200 && appSurface.status < 300 && !externalRedirect,
		appSurface.status >= 200 && appSurface.status < 300 && !externalRedirect
			? `${appUrl} is anonymously reachable`
			: `${appUrl} returned HTTP ${appSurface.status}${appSurface.location ? ` to ${appSurface.location}` : ""}`,
	);
	const scriptSources = cspSources(appSurface.contentSecurityPolicy, "script-src");
	const frameSources = cspSources(appSurface.contentSecurityPolicy, "frame-src");
	const googleAuthCspReady = scriptSources.includes("https://apis.google.com") &&
		scriptSources.includes("https://www.gstatic.com") &&
		frameSources.includes("https://accounts.google.com");
	record(
		"app-google-auth-csp",
		googleAuthCspReady,
		googleAuthCspReady
			? "App CSP allows the Firebase Google popup loader and Google account frame"
			: "App CSP must allow apis.google.com, www.gstatic.com and accounts.google.com for Firebase Google sign-in",
	);
	record(
		"deployed-email-link-route",
		routeProof.status === 400 && routeProof.body?.error_code === "INVALID_EMAIL",
		routeProof.status === 400 && routeProof.body?.error_code === "INVALID_EMAIL"
			? "Deployed App Worker exposes the fail-closed Firebase email-link route"
			: `Email-link route proof is not deployed (HTTP ${routeProof.status})`,
	);

	const frontendResult = run(process.execPath, [
		resolve(root, "scripts", "preflight-frontends-remote.mjs"),
		"--json",
	], { allowFailure: true });
	let clientFrontendReady = false;
	if (frontendResult.stdout) {
		try {
			const frontend = parseJsonOutput(frontendResult.stdout);
			const requiredClientChecks = [
				"vercel-auth",
				"client-project",
				"client-production-env",
				"client-production-alias",
				"client-anonymous-access",
			];
			clientFrontendReady = requiredClientChecks.every((id) =>
				frontend.checks?.some((check) => check.id === id && check.status === "ready"));
		} catch {
			clientFrontendReady = false;
		}
	}
	record(
		"app-vercel-config",
		clientFrontendReady,
		clientFrontendReady
			? "App Vercel project, production variables, alias and anonymous access are ready"
			: "App Vercel configuration is incomplete or could not be read",
	);

	const token = firebaseAccessToken();
	let firebaseReady = false;
	let firebaseDetail = "Firebase configuration could not be read with gcloud";
	if (token && firebaseProject === expectedFirebaseProject) {
		const headers = {
			Authorization: `Bearer ${token}`,
			"x-goog-user-project": firebaseProject,
		};
		const [config, google] = await Promise.all([
			getJson(`https://identitytoolkit.googleapis.com/admin/v2/projects/${encodeURIComponent(firebaseProject)}/config`, { headers }),
			getJson(`https://identitytoolkit.googleapis.com/admin/v2/projects/${encodeURIComponent(firebaseProject)}/defaultSupportedIdpConfigs/google.com`, { headers }),
		]);
		const appHost = new URL(appUrl).hostname;
		firebaseReady = config.ok && google.ok &&
			config.body?.signIn?.email?.enabled === true &&
			config.body?.signIn?.email?.passwordRequired !== true &&
			config.body?.authorizedDomains?.includes(appHost) === true &&
			google.body?.enabled === true;
		firebaseDetail = firebaseReady
			? `Firebase Google + passwordless Email Link are enabled for ${appHost}`
			: "Firebase must enable Google, passwordless Email Link and the App authorized domain";
	}
	record("firebase-auth-config", firebaseReady, firebaseDetail);

	const pending = checks.filter((check) => check.status === "pending");
	const result = {
		generatedAt: new Date().toISOString(),
		remoteMutationPerformed: false,
		realMailboxUsed: false,
		requiresAuthorizedRealMagicLinkProof: true,
		ready: pending.length === 0,
		checks,
		pending: pending.map((check) => check.id),
	};
	if (flags.has("--json")) console.log(JSON.stringify(result, null, 2));
	else {
		for (const check of checks) {
			console.log(`${check.status === "ready" ? "[ready]" : "[pending]"} ${check.id}: ${check.detail}`);
		}
		console.log(result.ready
			? "Phase 3 App remote infrastructure is ready; the authorized real magic-link proof remains separate."
			: `Phase 3 App remote infrastructure is not ready: ${result.pending.join(", ")}`);
	}
	if (!result.ready) process.exitCode = 2;
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}

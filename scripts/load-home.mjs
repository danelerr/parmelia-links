import { readFile } from "node:fs/promises";

function parseArgs(argv) {
	const options = {
		url: "http://127.0.0.1:8787/home",
		requests: 1_000,
		concurrency: 100,
		assertP95: 200,
		allowRemote: false,
		tokenFile: null,
	};
	for (let index = 0; index < argv.length; index++) {
		const key = argv[index];
		const value = argv[index + 1];
		if (key === "--url" && value) {
			options.url = value;
			index++;
		} else if (key === "--requests" && value) {
			options.requests = Number(value);
			index++;
		} else if (key === "--concurrency" && value) {
			options.concurrency = Number(value);
			index++;
		} else if (key === "--assert-p95" && value) {
			options.assertP95 = Number(value);
			index++;
		} else if (key === "--token-file" && value) {
			options.tokenFile = value;
			index++;
		} else if (key === "--allow-remote") {
			options.allowRemote = true;
		} else {
			throw new Error(`Unknown or incomplete argument: ${key}`);
		}
	}
	if (
		!Number.isSafeInteger(options.requests) ||
		options.requests < 1 ||
		options.requests > 100_000 ||
		!Number.isSafeInteger(options.concurrency) ||
		options.concurrency < 1 ||
		options.concurrency > 1_000 ||
		!Number.isFinite(options.assertP95) ||
		options.assertP95 < 1
	) {
		throw new Error("Invalid bounded load parameters");
	}
	const target = new URL(options.url);
	const local =
		target.hostname === "localhost" ||
		target.hostname === "127.0.0.1" ||
		target.hostname === "::1";
	if (!local && !options.allowRemote) {
		throw new Error("Remote load requires explicit --allow-remote");
	}
	return options;
}

function percentile(sorted, ratio) {
	if (sorted.length === 0) return null;
	return sorted[Math.min(
		sorted.length - 1,
		Math.max(0, Math.ceil(sorted.length * ratio) - 1),
	)];
}

function parseTokenFile(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return [];
	if (trimmed.startsWith("[")) {
		const parsed = JSON.parse(trimmed);
		if (
			!Array.isArray(parsed) ||
			parsed.some((token) => typeof token !== "string")
		) {
			throw new Error("Token JSON must be an array of strings");
		}
		return parsed.map((token) => token.trim()).filter(Boolean);
	}
	return trimmed
		.split(/\r?\n/u)
		.map((token) => token.trim())
		.filter(Boolean);
}

async function tokensFor(options) {
	const loadToken = process.env.GATOPAGO_LOAD_TOKEN || process.env.PARMELIA_LOAD_TOKEN;
	if (loadToken) {
		return [loadToken.trim()];
	}
	if (options.tokenFile) {
		return parseTokenFile(await readFile(options.tokenFile, "utf8"));
	}
	throw new Error(
		"Set GATOPAGO_LOAD_TOKEN or provide --token-file with one or more tokens (never pass tokens on the command line)",
	);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const suppliedTokens = await tokensFor(options);
	if (
		suppliedTokens.length < 1 ||
		suppliedTokens.length > 10_000 ||
		suppliedTokens.some((token) => token.length < 20)
	) {
		throw new Error("Load token set is missing, malformed, or too large");
	}
	// Warming identities that will never be used only adds hidden traffic.
	const tokens = suppliedTokens.slice(0, Math.min(suppliedTokens.length, options.requests));
	const identities = tokens.map((token) => ({ token, etag: null }));
	let warmCursor = 0;
	async function warmWorker() {
		for (;;) {
			const index = warmCursor++;
			if (index >= identities.length) return;
			const identity = identities[index];
			const warm = await fetch(options.url, {
				headers: { Authorization: `Bearer ${identity.token}` },
			});
			if (!warm.ok) {
				await warm.arrayBuffer();
				throw new Error(`Warm request ${index + 1} failed with HTTP ${warm.status}`);
			}
			await warm.arrayBuffer();
			identity.etag = warm.headers.get("etag");
		}
	}
	await Promise.all(
		Array.from(
			{ length: Math.min(50, options.concurrency, identities.length) },
			() => warmWorker(),
		),
	);

	const latencies = [];
	const statuses = new Map();
	let cursor = 0;
	const startedAt = performance.now();
	async function worker() {
		for (;;) {
			const current = cursor++;
			if (current >= options.requests) return;
			const identity = identities[current % identities.length];
			const started = performance.now();
			try {
				const response = await fetch(options.url, {
					headers: {
						Authorization: `Bearer ${identity.token}`,
						...(identity.etag ? { "If-None-Match": identity.etag } : {}),
					},
				});
				await response.arrayBuffer();
				latencies.push(performance.now() - started);
				statuses.set(
					response.status,
					(statuses.get(response.status) ?? 0) + 1,
				);
			} catch {
				latencies.push(performance.now() - started);
				statuses.set(0, (statuses.get(0) ?? 0) + 1);
			}
		}
	}
	await Promise.all(
		Array.from(
			{ length: Math.min(options.concurrency, options.requests) },
			() => worker(),
		),
	);
	const elapsedMs = performance.now() - startedAt;
	latencies.sort((left, right) => left - right);
	const result = {
		targetOrigin: new URL(options.url).origin,
		requests: options.requests,
		concurrency: options.concurrency,
		identities: identities.length,
		etagRevalidation:
			identities.filter((identity) => Boolean(identity.etag)).length,
		statuses: Object.fromEntries(
			[...statuses.entries()].sort(([left], [right]) => left - right),
		),
		requestsPerSecond: Number(
			(options.requests / (elapsedMs / 1_000)).toFixed(2),
		),
		p50Ms: Number(percentile(latencies, 0.5)?.toFixed(2)),
		p95Ms: Number(percentile(latencies, 0.95)?.toFixed(2)),
		p99Ms: Number(percentile(latencies, 0.99)?.toFixed(2)),
	};
	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

	const serverErrors = [...statuses.entries()]
		.filter(([status]) => status === 0 || status >= 500)
		.reduce((sum, [, count]) => sum + count, 0);
	if (serverErrors > 0 || result.p95Ms > options.assertP95) {
		process.exitCode = 1;
	}
}

await main();

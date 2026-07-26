#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const FORMAT = "parmelia-release-v1";
const MANIFEST_NAME = "release-manifest.json";
const MAX_FILES = 20_000;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;

function usage() {
	return [
		"Usage:",
		"  node scripts/release-artifact.mjs --create <directory> [--commit <sha>]",
		"  node scripts/release-artifact.mjs --verify <directory> [--expected-commit <sha>]",
		"  node scripts/release-artifact.mjs --drill",
	].join("\n");
}

function normalizeCommit(value) {
	const commit = value?.trim().toLowerCase();
	if (!commit || !/^[0-9a-f]{40}$/.test(commit)) {
		throw new Error("Release commit must be a full 40-character Git SHA");
	}
	return commit;
}

function currentCommit() {
	return normalizeCommit(execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }));
}

function safeRelativePath(value) {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 512 &&
		!value.includes("\\") &&
		!value.includes("\0") &&
		!path.posix.isAbsolute(value) &&
		path.posix.normalize(value) === value &&
		value !== ".." &&
		!value.startsWith("../")
	);
}

function comparePaths(left, right) {
	return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function hashFile(filename) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(filename)) hash.update(chunk);
	return hash.digest("hex");
}

async function listArtifactFiles(root) {
	const rootStats = await stat(root).catch(() => null);
	if (!rootStats?.isDirectory()) throw new Error(`Artifact directory does not exist: ${root}`);

	const files = [];
	async function walk(directory, prefix = "") {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((left, right) => comparePaths(left.name, right.name));
		for (const entry of entries) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (!safeRelativePath(relative)) throw new Error(`Unsafe artifact path: ${relative}`);
			const absolute = path.join(directory, entry.name);
			const entryStats = await lstat(absolute);
			if (entryStats.isSymbolicLink()) throw new Error(`Symbolic links are forbidden in releases: ${relative}`);
			if (entryStats.isDirectory()) {
				await walk(absolute, relative);
				continue;
			}
			if (!entryStats.isFile()) throw new Error(`Unsupported artifact entry: ${relative}`);
			if (relative === MANIFEST_NAME) continue;
			files.push({ path: relative, absolute, size: entryStats.size });
			if (files.length > MAX_FILES) throw new Error(`Artifact exceeds ${MAX_FILES} files`);
		}
	}

	await walk(root);
	return files;
}

async function createManifest(rootInput, commitInput) {
	const root = path.resolve(rootInput);
	const files = await listArtifactFiles(root);
	if (files.length === 0) throw new Error("Release artifact cannot be empty");

	const manifest = {
		format: FORMAT,
		commit: normalizeCommit(commitInput ?? currentCommit()),
		files: [],
	};
	for (const file of files) {
		const digest = await hashFile(file.absolute);
		const after = await stat(file.absolute);
		if (!after.isFile() || after.size !== file.size) {
			throw new Error(`Artifact changed while hashing: ${file.path}`);
		}
		manifest.files.push({ path: file.path, size: file.size, sha256: digest });
	}
	manifest.files.sort((left, right) => comparePaths(left.path, right.path));

	const target = path.join(root, MANIFEST_NAME);
	const temporary = `${target}.${process.pid}.tmp`;
	try {
		await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
		await rename(temporary, target);
	} finally {
		await rm(temporary, { force: true });
	}
	return manifest;
}

function validateManifest(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Release manifest must be an object");
	if (value.format !== FORMAT) throw new Error(`Unsupported release manifest format: ${String(value.format)}`);
	const commit = normalizeCommit(value.commit);
	if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > MAX_FILES) {
		throw new Error("Release manifest has an invalid file list");
	}

	let previous = "";
	const files = value.files.map((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid release file entry");
		if (!safeRelativePath(entry.path) || entry.path === MANIFEST_NAME) throw new Error(`Invalid release path: ${String(entry.path)}`);
		if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`Invalid release size: ${entry.path}`);
		if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) {
			throw new Error(`Invalid release digest: ${entry.path}`);
		}
		if (previous && comparePaths(entry.path, previous) <= 0) {
			throw new Error(`Release paths are duplicated or unsorted: ${entry.path}`);
		}
		previous = entry.path;
		return { path: entry.path, size: entry.size, sha256: entry.sha256 };
	});
	return { format: FORMAT, commit, files };
}

async function verifyManifest(rootInput, expectedCommitInput) {
	const root = path.resolve(rootInput);
	const manifestPath = path.join(root, MANIFEST_NAME);
	const manifestStats = await stat(manifestPath).catch(() => null);
	if (!manifestStats?.isFile() || manifestStats.size > MAX_MANIFEST_BYTES) {
		throw new Error("Release manifest is missing or too large");
	}
	const raw = await readFile(manifestPath, "utf8");
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Release manifest is not valid JSON");
	}
	const manifest = validateManifest(parsed);
	if (expectedCommitInput && manifest.commit !== normalizeCommit(expectedCommitInput)) {
		throw new Error(`Release commit mismatch: expected ${expectedCommitInput}, found ${manifest.commit}`);
	}

	const actualFiles = await listArtifactFiles(root);
	const actualByPath = new Map(actualFiles.map((file) => [file.path, file]));
	const actualPaths = actualFiles.map((file) => file.path).sort(comparePaths);
	const expectedPaths = manifest.files.map((file) => file.path);
	if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) {
		throw new Error("Release contents do not match the manifest (missing or extra files)");
	}

	for (const expected of manifest.files) {
		const actual = actualByPath.get(expected.path);
		if (!actual || actual.size !== expected.size) throw new Error(`Release size mismatch: ${expected.path}`);
		const digest = await hashFile(actual.absolute);
		if (!timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(expected.sha256, "hex"))) {
			throw new Error(`Release digest mismatch: ${expected.path}`);
		}
	}
	return manifest;
}

async function expectFailure(action, pattern) {
	try {
		await action();
	} catch (error) {
		if (pattern.test(error instanceof Error ? error.message : String(error))) return;
		throw error;
	}
	throw new Error(`Expected failure matching ${pattern}`);
}

async function drill() {
	const root = await mkdtemp(path.join(tmpdir(), "parmelia-release-drill-"));
	try {
		await mkdir(path.join(root, "nested"));
		await writeFile(path.join(root, "index.js"), "export default {};\n", "utf8");
		await writeFile(path.join(root, "nested", "metadata.txt"), "verified\n", "utf8");
		const commit = "a".repeat(40);
		await createManifest(root, commit);
		await verifyManifest(root, commit);

		await writeFile(path.join(root, "index.js"), "tampered\n", "utf8");
		await expectFailure(() => verifyManifest(root, commit), /size mismatch|digest mismatch/);

		await writeFile(path.join(root, "index.js"), "export default {};\n", "utf8");
		await createManifest(root, commit);
		await writeFile(path.join(root, "extra.txt"), "unexpected\n", "utf8");
		await expectFailure(() => verifyManifest(root, commit), /missing or extra files/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

function optionalCommandValue(args, name) {
	if (args.length === 2) return undefined;
	if (args.length !== 4 || args[2] !== name || !args[3] || args[3].startsWith("--")) {
		throw new Error(`Invalid arguments\n${usage()}`);
	}
	return args[3];
}

async function main() {
	const args = process.argv.slice(2);
	if (args[0] === "--drill" && args.length === 1) {
		await drill();
		process.stdout.write("Release artifact drill passed (tamper and extra-file checks OK).\n");
		return;
	}
	if (args[0] === "--create") {
		if (!args[1] || args[1].startsWith("--")) throw new Error(`--create requires a directory\n${usage()}`);
		const manifest = await createManifest(args[1], optionalCommandValue(args, "--commit"));
		process.stdout.write(`Created ${MANIFEST_NAME} for ${manifest.files.length} files at commit ${manifest.commit}.\n`);
		return;
	}
	if (args[0] === "--verify") {
		if (!args[1] || args[1].startsWith("--")) throw new Error(`--verify requires a directory\n${usage()}`);
		const manifest = await verifyManifest(args[1], optionalCommandValue(args, "--expected-commit"));
		process.stdout.write(`Verified ${manifest.files.length} release files for commit ${manifest.commit}.\n`);
		return;
	}
	throw new Error(usage());
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});

import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoots = [resolve(root, "client/src"), resolve(root, "dashboard/src")];
const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx"]);
const forbidden = [
	/\bunstable_RSC\w*\b/u,
	/from\s+["']react-router\/dom\/server["']/u,
	/from\s+["']@react-router\/\w*rsc\w*["']/iu,
	/\bRSCRouterConfig\b/u,
];

async function sourceFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await sourceFiles(path)));
		} else if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
			files.push(path);
		}
	}
	return files;
}

for (const sourceRoot of sourceRoots) {
	for (const file of await sourceFiles(sourceRoot)) {
		const source = await readFile(file, "utf8");
		for (const pattern of forbidden) {
			if (pattern.test(source)) {
				throw new Error(
					`${relative(root, file)} uses a forbidden unstable React Router RSC API`,
				);
			}
		}
	}
}

process.stdout.write("No unstable React Router RSC APIs are used.\n");

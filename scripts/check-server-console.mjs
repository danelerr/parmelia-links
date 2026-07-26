import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const sourceRoot = path.resolve("server/src");
const loggerPath = path.join(sourceRoot, "services", "logger.ts");
const consoleCall = /\bconsole\.(?:debug|error|info|log|warn)\s*\(/g;

async function sourceFiles(directory) {
	const entries = await readdir(directory, { withFileTypes: true });
	const nested = await Promise.all(
		entries.map((entry) => {
			const target = path.join(directory, entry.name);
			if (entry.isDirectory()) return sourceFiles(target);
			return entry.isFile() && entry.name.endsWith(".ts") ? [target] : [];
		}),
	);
	return nested.flat();
}

const violations = [];
for (const file of await sourceFiles(sourceRoot)) {
	if (file === loggerPath) continue;
	const lines = (await readFile(file, "utf8")).split(/\r?\n/);
	for (const [index, line] of lines.entries()) {
		consoleCall.lastIndex = 0;
		if (consoleCall.test(line)) {
			violations.push(`${path.relative(process.cwd(), file)}:${index + 1}`);
		}
	}
}

if (violations.length > 0) {
	console.error(`Unstructured server console calls:\n${violations.map((item) => `- ${item}`).join("\n")}`);
	process.exit(1);
}

console.log("Server logs are structured.");

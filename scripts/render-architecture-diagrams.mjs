import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const PLANTUML_VERSION = "1.2026.7";
const PLANTUML_SHA256 = "33aa7ed0ca843e300690230d09268e1f526fdde7e86fecdfa39fb80412cafcde";
const PLANTUML_URL = `https://github.com/plantuml/plantuml/releases/download/v${PLANTUML_VERSION}/plantuml.jar`;

const root = resolve(import.meta.dirname, "..");
const committedSourceDirectory = resolve(root, "docs", "architecture", "diagrams");
const committedOutputDirectory = resolve(root, "docs", "architecture", "rendered");
const jarPath = resolve(tmpdir(), `gatopago-plantuml-${PLANTUML_VERSION}.jar`);
const checkOnly = process.argv.includes("--check");

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function plantUmlJar() {
  if (existsSync(jarPath)) {
    const current = readFileSync(jarPath);
    if (digest(current) === PLANTUML_SHA256) return jarPath;
  }

  const response = await fetch(PLANTUML_URL, { redirect: "follow" });
  if (!response.ok) throw new Error(`Cannot download PlantUML ${PLANTUML_VERSION}: HTTP ${response.status}`);
  const jar = Buffer.from(await response.arrayBuffer());
  const actual = digest(jar);
  if (actual !== PLANTUML_SHA256) {
    throw new Error(`PlantUML checksum mismatch: expected ${PLANTUML_SHA256}, got ${actual}`);
  }
  writeFileSync(jarPath, jar, { flag: "w" });
  return jarPath;
}

function diagramSources(directory) {
	return readdirSync(directory)
		.filter((name) => /^\d{2}-.*\.puml$/u.test(name))
		.sort()
		.map((name) => resolve(directory, name));
}

function verifySvg(path) {
  const svg = readFileSync(path, "utf8");
  if (!svg.includes("<svg") || /Dot Executable|Syntax Error|No dot executable|Cannot find/iu.test(svg)) {
    throw new Error(`Invalid PlantUML render: ${path}`);
  }
}

const temporaryRoot = checkOnly ? mkdtempSync(join(tmpdir(), "gatopago-architecture-")) : null;
try {
	const sourceDirectory = temporaryRoot ? resolve(temporaryRoot, "diagrams") : committedSourceDirectory;
	const outputDirectory = temporaryRoot ? resolve(temporaryRoot, "rendered") : committedOutputDirectory;
	if (temporaryRoot) cpSync(committedSourceDirectory, sourceDirectory, { recursive: true });
	const jar = await plantUmlJar();
	const sources = diagramSources(sourceDirectory);
	if (sources.length === 0) throw new Error("No numbered architecture diagrams found");
	mkdirSync(outputDirectory, { recursive: true });

	const result = spawnSync("java", [
		"-DPLANTUML_LIMIT_SIZE=16384",
		"-jar",
		jar,
		"-tsvg",
		"-charset",
		"UTF-8",
		"-o",
		"../rendered",
		...sources,
	], {
		cwd: root,
		encoding: "utf8",
		windowsHide: true,
		maxBuffer: 16 * 1024 * 1024,
	});

	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error((result.stderr || result.stdout || "PlantUML render failed").trim());

	const expectedNames = sources.map((source) => source.split(/[\\/]/u).at(-1).replace(/\.puml$/u, ".svg"));
	if (!checkOnly) {
		const expectedNameSet = new Set(expectedNames);
		for (const name of readdirSync(committedOutputDirectory)) {
			if (name.endsWith(".svg") && !expectedNameSet.has(name)) {
				unlinkSync(resolve(committedOutputDirectory, name));
			}
		}
	}
	for (const name of expectedNames) verifySvg(resolve(outputDirectory, name));
	if (checkOnly) {
		const committedNames = readdirSync(committedOutputDirectory).filter((name) => name.endsWith(".svg")).sort();
		if (JSON.stringify(committedNames) !== JSON.stringify(expectedNames)) {
			throw new Error("Committed architecture SVG names do not match the numbered PlantUML sources");
		}
		for (const name of expectedNames) {
			if (digest(readFileSync(resolve(outputDirectory, name))) !==
				digest(readFileSync(resolve(committedOutputDirectory, name)))) {
				throw new Error(`Architecture render is stale: ${name}`);
			}
		}
	}
	console.log(`Architecture diagrams ${checkOnly ? "checked" : "rendered"} and verified: ${sources.length} SVGs (PlantUML ${PLANTUML_VERSION}).`);
} finally {
	if (temporaryRoot) {
		const resolvedTemporaryRoot = resolve(temporaryRoot);
		const resolvedSystemTemp = `${resolve(tmpdir())}${sep}`;
		if (!resolvedTemporaryRoot.startsWith(resolvedSystemTemp)) {
			throw new Error(`Refusing to remove unexpected architecture temp path: ${resolvedTemporaryRoot}`);
		}
		rmSync(resolvedTemporaryRoot, { recursive: true, force: true });
	}
}

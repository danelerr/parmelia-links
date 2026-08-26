import { gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const targets = [
	{ dir: "dashboard/dist/assets", maxFile: 220 * 1024, maxTotal: 500 * 1024 },
];

async function gzipSizes(directory) {
	const files = (await readdir(directory)).filter((file) => file.endsWith(".js"));
	return new Map(await Promise.all(files.map(async (file) => [
		`assets/${file}`,
		gzipSync(await readFile(join(directory, file))).byteLength,
	])));
}

function manifestGraph(manifest, start) {
	const seen = new Set();
	const visit = (key) => {
		if (!key || seen.has(key)) return;
		seen.add(key);
		const entry = manifest[key];
		if (!entry) return;
		for (const dependency of entry.imports ?? []) visit(dependency);
		for (const dependency of entry.dynamicImports ?? []) visit(dependency);
	};
	visit(start);
	return seen;
}

const clientManifest = JSON.parse(await readFile("client/dist/.vite/manifest.json", "utf8"));
const clientSizes = await gzipSizes("client/dist/assets");
const appEntry = Object.keys(clientManifest).find((key) => clientManifest[key].isEntry);
if (!appEntry) throw new Error("Client Vite manifest has no application entry");
const coreGraph = manifestGraph(clientManifest, appEntry);
const coreFiles = new Set([...coreGraph].map((key) => clientManifest[key]?.file).filter((file) => file?.endsWith(".js")));
const sum = (files) => [...files].reduce((total, file) => total + (clientSizes.get(file) ?? 0), 0);
const coreTotal = sum(coreFiles);
for (const file of coreFiles) {
	const bytes = clientSizes.get(file) ?? 0;
	if (bytes > 220 * 1024) throw new Error(`${file} is ${bytes} gzip bytes; core limit ${220 * 1024}`);
}
if (coreTotal > 600 * 1024) throw new Error(`Client core graph is ${coreTotal} gzip bytes; limit ${600 * 1024}`);
console.log(`client/dist/assets: core ${coreTotal} gzip bytes`);

for (const target of targets) {
	const files = (await readdir(target.dir)).filter((file) => file.endsWith(".js"));
	let total = 0;
	for (const file of files) {
		const bytes = gzipSync(await readFile(join(target.dir, file))).byteLength;
		total += bytes;
		if (bytes > target.maxFile) {
			throw new Error(`${relative(".", join(target.dir, file))} is ${bytes} gzip bytes; limit ${target.maxFile}`);
		}
	}
	if (total > target.maxTotal) {
		throw new Error(`${target.dir} totals ${total} gzip bytes; limit ${target.maxTotal}`);
	}
	console.log(`${target.dir}: ${files.length} JS chunks, ${total} gzip bytes`);
}

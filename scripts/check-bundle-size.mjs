import { gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const targets = [
	{ dir: "client/dist/assets", maxFile: 220 * 1024, maxTotal: 600 * 1024 },
	{ dir: "dashboard/dist/assets", maxFile: 220 * 1024, maxTotal: 500 * 1024 },
];

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

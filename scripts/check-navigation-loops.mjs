import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const appSource = await readFile(resolve(root, "client/src/App.tsx"), "utf8");
const backHeaderSource = await readFile(
	resolve(root, "client/src/components/BackHeader.tsx"),
	"utf8",
);

const redirects = [...appSource.matchAll(/<Navigate\b[^>]*\/>/gsu)].map(
	(match) => match[0],
);
const unsafeRedirect = redirects.find((redirect) => !/\breplace\b/u.test(redirect));
if (unsafeRedirect) {
	throw new Error(`Route guard/alias must replace history: ${unsafeRedirect}`);
}

if (/navigate\s*\(\s*-1\s*\)|history\.(?:back|go)\s*\(/u.test(backHeaderSource)) {
	throw new Error(
		"BackHeader must use a deterministic parent route, not browser-history deltas",
	);
}

process.stdout.write(
	`Navigation loop guard passed (${redirects.length} redirects checked).\n`,
);

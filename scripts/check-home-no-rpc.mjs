import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = [
	"server/src/routes/home.routes.ts",
	"server/src/services/homeReadModel.ts",
];
const forbidden = [
	/from\s+["'][^"']*\/clients["']/u,
	/\bgetPublicClient\b/u,
	/\bgetIndexerClient\b/u,
	/\.getLogs\s*\(/u,
	/\.readContract\s*\(/u,
	/\.getBalance\s*\(/u,
	/\beth_(?:call|getLogs|getBalance)\b/u,
	/\bscheduleWalletIndexerPartitions\b/u,
];

for (const relative of files) {
	const source = await readFile(resolve(root, relative), "utf8");
	for (const pattern of forbidden) {
		if (pattern.test(source)) {
			throw new Error(
				`${relative} violates the zero-RPC Home boundary (${pattern})`,
			);
		}
	}
}

const hookSource = await readFile(
	resolve(root, "client/src/hooks/useHomeModel.ts"),
	"utf8",
);
if (/latest\.balance\.(?:refreshing|status)/u.test(hookSource)) {
	throw new Error(
		"Home polling must not accelerate merely because the balance projection is stale",
	);
}

process.stdout.write("Home read path has no RPC imports or calls.\n");

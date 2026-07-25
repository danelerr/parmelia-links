import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import v1 from "../src/routes/v1.routes";

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

type OpenApiDocument = {
	openapi?: string;
	paths?: Record<string, Record<string, unknown>>;
};

function documentedOperations(document: OpenApiDocument): string[] {
	return Object.entries(document.paths ?? {})
		.flatMap(([path, pathItem]) =>
			Object.keys(pathItem)
				.filter((method) => HTTP_METHODS.has(method.toLowerCase()))
				.map((method) => `${method.toUpperCase()} ${path}`),
		)
		.sort();
}

function implementedOperations(): string[] {
	return v1.routes
		.filter((route) => route.method !== "ALL")
		.map((route) => {
			const openApiPath = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
			return `${route.method} /v1${openApiPath}`;
		})
		.sort();
}

describe("public OpenAPI contract", () => {
	it("documents exactly every registered /v1 operation", async () => {
		const source = await readFile(new URL("../../docs/openapi.yaml", import.meta.url), "utf8");
		const document = parse(source) as OpenApiDocument;

		expect(document.openapi).toMatch(/^3\.1\./);
		expect(documentedOperations(document)).toEqual(implementedOperations());
	});

	it("defines responses for every documented operation", async () => {
		const source = await readFile(new URL("../../docs/openapi.yaml", import.meta.url), "utf8");
		const document = parse(source) as OpenApiDocument;

		for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
			for (const [method, operation] of Object.entries(pathItem)) {
				if (!HTTP_METHODS.has(method.toLowerCase())) continue;
				expect(operation, `${method.toUpperCase()} ${path}`).toMatchObject({ responses: expect.any(Object) });
			}
		}
	});
});

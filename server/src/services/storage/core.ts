import type { Bindings } from "../../middlewares/auth";

export function nowIso() {
	return new Date().toISOString();
}

export async function d1First<Row>(env: Bindings, query: string, params: unknown[] = []): Promise<Row | null> {
	return (await env.GATOPAGO_DB.prepare(query).bind(...params).first<Row>()) ?? null;
}

export async function d1All<Row>(env: Bindings, query: string, params: unknown[] = []): Promise<Row[]> {
	const result = await env.GATOPAGO_DB.prepare(query).bind(...params).all<Row>();
	return (result.results ?? []) as Row[];
}

export async function d1Run(env: Bindings, query: string, params: unknown[] = []) {
	return await env.GATOPAGO_DB.prepare(query).bind(...params).run();
}

/** True when the statement actually wrote a row (atomic claim / guarded update). */
export function didWrite(result: { meta?: { changes?: number } }): boolean {
	return (result.meta?.changes ?? 0) > 0;
}

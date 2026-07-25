import { useState } from "react";
import useSWRInfinite from "swr/infinite";
import { sileo } from "sileo";
import { apiFetch } from "../lib/api";
import type { User } from "../lib/firebase";
import ErrorState from "../components/ErrorState";
import { formatDateTime } from "../lib/format";

type Event = {
	id: string;
	type: string;
	objectId: string | null;
	payload: Record<string, unknown>;
	mode: "test" | "live";
	createdAt: string;
};

type Page = { data: Event[]; has_more?: boolean };

const PAGE_SIZE = 50;

function getKey(index: number, prev: Page | null) {
	if (prev && !(prev.has_more ?? false)) return null;
	if (index === 0) return `/merchant/events?limit=${PAGE_SIZE}`;
	const last = prev?.data[prev.data.length - 1];
	return last ? `/merchant/events?limit=${PAGE_SIZE}&starting_after=${last.id}` : null;
}

export default function Events({ user }: { user: User }) {
	const { data: pages, error, isLoading, size, setSize, mutate } = useSWRInfinite(
		getKey,
		(p: string) => apiFetch<Page>(p, { user }),
		{ refreshInterval: 15000 },
	);
	const events = pages?.flatMap((p) => p.data) ?? [];
	const hasMore = pages && pages.length > 0 ? (pages[pages.length - 1].has_more ?? false) : false;
	const loadingMore = size > 0 && pages !== undefined && pages.length < size;
	const loadMoreError = Boolean(error && pages);
	// Row whose payload is expanded (the JSON your webhook endpoint received).
	const [openId, setOpenId] = useState<string | null>(null);

	async function copy(value: string) {
		try {
			await navigator.clipboard.writeText(value);
			sileo.success({ title: "Copiado" });
		} catch {
			sileo.error({ title: "No se pudo copiar", description: "Copia el valor manualmente." });
		}
	}

	return (
		<div>
			<header className="mb-7">
				<h1 className="text-[26px] mb-1">Eventos</h1>
				<p className="text-[14px] text-text-muted">
					Log inmutable de lo que disparó tus webhooks. Toca un evento para ver el payload exacto que enviamos.
				</p>
			</header>

			{isLoading && !pages ? (
				<p className="text-[14px] text-text-muted">Cargando…</p>
			) : error && !pages ? (
				<ErrorState message={error instanceof Error ? error.message : undefined} onRetry={() => mutate()} />
			) : events.length === 0 ? (
				<p className="text-[14px] text-text-muted">Sin eventos todavía.</p>
			) : (
				<div className="card divide-y divide-border">
					{events.map((e) => {
						const open = openId === e.id;
						const json = JSON.stringify(e.payload, null, 2);
						return (
							<div key={e.id}>
								<button
									onClick={() => setOpenId(open ? null : e.id)}
									aria-expanded={open}
									className="w-full flex items-center gap-4 px-5 py-3.5 text-left hover:bg-surface-2 transition-colors"
								>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="badge badge-ok">{e.type}</span>
											{e.mode === "test" && <span className="badge badge-muted">test</span>}
										</div>
										<p className="text-[12px] text-text-faint mt-0.5 truncate">
											<code className="mono">{e.objectId ?? e.id}</code>
										</p>
									</div>
									<span className="text-[12px] text-text-faint shrink-0">{formatDateTime(e.createdAt)}</span>
									<span className="text-[12px] text-text-faint shrink-0">{open ? "cerrar" : "ver"}</span>
								</button>
								{open && (
									<div className="px-5 pb-4">
										<p className="text-[12px] text-text-faint mb-2">
											Este es el objeto <span className="mono">data</span> del cuerpo firmado que recibió tu
											endpoint (evento <code className="mono">{e.id}</code>).
										</p>
										<div className="relative">
											<pre className="bg-bg border border-border rounded-[12px] p-3 overflow-x-auto text-[12px] mono text-text-muted leading-relaxed max-h-80">
												{json}
											</pre>
											<button onClick={() => copy(json)} className="btn btn-ghost btn-sm absolute top-2 right-2">
												Copiar
											</button>
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}

			{hasMore && (
				<div className="flex justify-center mt-4">
					<button
						onClick={() => (loadMoreError ? mutate() : setSize(size + 1))}
						disabled={loadingMore && !loadMoreError}
						className="btn btn-ghost btn-sm"
					>
						{loadMoreError ? "Reintentar" : loadingMore ? "Cargando…" : "Cargar más"}
					</button>
				</div>
			)}
		</div>
	);
}

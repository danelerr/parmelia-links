import { useEffect, useState } from "react";
import useSWRInfinite from "swr/infinite";
import { Link } from "react-router-dom";
import { apiFetch } from "../lib/api";
import type { User } from "../lib/firebase";
import ErrorState from "../components/ErrorState";
import { formatAmount, formatDateTime } from "../lib/format";

type Intent = {
	id: string;
	// Known values today: awaiting_payment | paid | expired | canceled — but the
	// API may add more, so we keep it open and render unknown ones as-is.
	status: string;
	amount: string;
	currency: string;
	reference: string | null;
	mode: "test" | "live";
	created_at: string;
};

type Page = { data: Intent[]; has_more?: boolean };

const PAGE_SIZE = 25;

const STATUS: Record<string, { label: string; cls: string }> = {
	paid: { label: "pagado", cls: "badge-ok" },
	awaiting_payment: { label: "esperando", cls: "badge" },
	expired: { label: "expirado", cls: "badge-muted" },
	canceled: { label: "cancelado", cls: "badge-muted" },
};

export default function Payments({ user }: { user: User }) {
	// Server-side filters (part of the SWR key, so each combination paginates
	// correctly); the text search is client-side over the loaded rows.
	const [statusF, setStatusF] = useState("all");
	const [modeF, setModeF] = useState("all");
	const [search, setSearch] = useState("");

	const filterQs =
		(statusF !== "all" ? `&status=${statusF}` : "") + (modeF !== "all" ? `&mode=${modeF}` : "");

	function getKey(index: number, prev: Page | null) {
		if (prev && !(prev.has_more ?? false)) return null; // reached the end
		if (index === 0) return `/merchant/payment_intents?limit=${PAGE_SIZE}${filterQs}`;
		const last = prev?.data[prev.data.length - 1];
		return last
			? `/merchant/payment_intents?limit=${PAGE_SIZE}${filterQs}&starting_after=${last.id}`
			: null;
	}

	const { data: pages, error, isLoading, size, setSize, mutate } = useSWRInfinite(
		getKey,
		(p: string) => apiFetch<Page>(p, { user }),
		{ refreshInterval: 15000 },
	);

	// Changing a filter changes every key: collapse back to one page.
	useEffect(() => {
		void setSize(1);
	}, [filterQs, setSize]);

	const loaded = pages?.flatMap((p) => p.data) ?? [];
	const q = search.trim().toLowerCase();
	const intents = q
		? loaded.filter(
				(i) => i.id.toLowerCase().includes(q) || (i.reference ?? "").toLowerCase().includes(q),
			)
		: loaded;
	const hasMore = pages && pages.length > 0 ? (pages[pages.length - 1].has_more ?? false) : false;
	const loadingMore = size > 0 && pages !== undefined && pages.length < size;
	// A page fetch failed while we already have data (e.g. "Cargar más" broke).
	const loadMoreError = Boolean(error && pages);

	return (
		<div>
			<header className="mb-6">
				<h1 className="text-[26px] mb-1">Pagos</h1>
				<p className="text-[14px] text-text-muted">Tus payment intents y su estado.</p>
			</header>

			{/* Filters */}
			<div className="flex flex-col sm:flex-row gap-2.5 mb-5">
				<input
					className="field flex-1"
					type="search"
					name="search"
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Buscar por id (pi_…) o referencia"
					aria-label="Buscar por id o referencia"
					autoComplete="off"
					spellCheck={false}
				/>
				<select
					className="field sm:w-44"
					name="status"
					value={statusF}
					onChange={(e) => setStatusF(e.target.value)}
					aria-label="Filtrar por estado"
				>
					<option value="all">Todos los estados</option>
					<option value="paid">Pagado</option>
					<option value="awaiting_payment">Esperando</option>
					<option value="expired">Expirado</option>
					<option value="canceled">Cancelado</option>
				</select>
				<select
					className="field sm:w-36"
					value={modeF}
					onChange={(e) => setModeF(e.target.value)}
					aria-label="Filtrar por modo"
				>
					<option value="all">Test y live</option>
					<option value="live">live</option>
					<option value="test">test</option>
				</select>
			</div>

			{isLoading && !pages ? (
				<p className="text-[14px] text-text-muted">Cargando…</p>
			) : error && !pages ? (
				<ErrorState message={error instanceof Error ? error.message : undefined} onRetry={() => mutate()} />
			) : intents.length === 0 ? (
				<p className="text-[14px] text-text-muted">
					{q || statusF !== "all" || modeF !== "all"
						? "Ningún cobro coincide con los filtros."
						: "Todavía no hay cobros."}
				</p>
			) : (
				<>
					<div className="card divide-y divide-border">
						{intents.map((i) => {
							const s = STATUS[i.status] ?? { label: i.status, cls: "badge" };
							return (
								<Link key={i.id} to={`/payments/${i.id}`} className="flex items-center gap-4 px-5 py-3.5 hover:bg-surface-2 transition-colors">
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2">
											<span className="text-[15px] tabular font-medium">
												{formatAmount(i.amount)} {i.currency}
											</span>
											<span className={`badge ${s.cls}`}>{s.label}</span>
											{i.mode === "test" && <span className="badge badge-muted">test</span>}
										</div>
										<p className="text-[12px] text-text-faint mt-0.5 truncate">
											<code className="mono">{i.id}</code>
											{i.reference ? ` · ${i.reference}` : ""}
										</p>
									</div>
									<span className="text-[12px] text-text-faint shrink-0">{formatDateTime(i.created_at)}</span>
								</Link>
							);
						})}
					</div>
					{q && hasMore && (
						<p className="text-[12px] text-text-faint mt-2">
							La búsqueda filtra los cobros ya cargados; usa "Cargar más" para ampliar.
						</p>
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
				</>
			)}
		</div>
	);
}

import useSWR from "swr";
import { apiFetch } from "../lib/api";
import type { User } from "../lib/firebase";

type Event = {
	id: string;
	type: string;
	objectId: string | null;
	mode: "test" | "live";
	createdAt: string;
};

function fmt(iso: string) {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function Events({ user }: { user: User }) {
	const { data, isLoading } = useSWR(
		"/merchant/events",
		(p: string) => apiFetch<{ data: Event[] }>(p, { user }),
		{ refreshInterval: 15000 },
	);
	const events = data?.data ?? [];

	return (
		<div>
			<header className="mb-7">
				<h1 className="text-[26px] mb-1">Eventos</h1>
				<p className="text-[14px] text-text-muted">Log inmutable de lo que disparó tus webhooks.</p>
			</header>

			{isLoading && !data ? (
				<p className="text-[14px] text-text-muted">Cargando…</p>
			) : events.length === 0 ? (
				<p className="text-[14px] text-text-muted">Sin eventos todavía.</p>
			) : (
				<div className="card divide-y divide-border">
					{events.map((e) => (
						<div key={e.id} className="flex items-center gap-4 px-5 py-3.5">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span className="badge badge-ok">{e.type}</span>
									{e.mode === "test" && <span className="badge badge-muted">test</span>}
								</div>
								<p className="text-[12px] text-text-faint mt-0.5 truncate">
									<code className="mono">{e.objectId ?? e.id}</code>
								</p>
							</div>
							<span className="text-[12px] text-text-faint shrink-0">{fmt(e.createdAt)}</span>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

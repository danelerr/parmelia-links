import useSWR from "swr";
import { apiFetch } from "../lib/api";
import type { User } from "../lib/firebase";

type Intent = {
	id: string;
	status: "awaiting_payment" | "paid" | "expired" | "canceled";
	amount: string;
	currency: string;
	reference: string | null;
	mode: "test" | "live";
	created_at: string;
};

const STATUS: Record<Intent["status"], { label: string; cls: string }> = {
	paid: { label: "pagado", cls: "badge-ok" },
	awaiting_payment: { label: "esperando", cls: "badge" },
	expired: { label: "expirado", cls: "badge-muted" },
	canceled: { label: "cancelado", cls: "badge-muted" },
};

function fmt(iso: string) {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("es", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function Payments({ user }: { user: User }) {
	const { data, isLoading } = useSWR(
		"/merchant/payment_intents",
		(p: string) => apiFetch<{ data: Intent[] }>(p, { user }),
		{ refreshInterval: 15000 },
	);
	const intents = data?.data ?? [];

	return (
		<div>
			<header className="mb-7">
				<h1 className="text-[26px] mb-1">Pagos</h1>
				<p className="text-[14px] text-text-muted">Tus payment intents y su estado.</p>
			</header>

			{isLoading && !data ? (
				<p className="text-[14px] text-text-muted">Cargando…</p>
			) : intents.length === 0 ? (
				<p className="text-[14px] text-text-muted">Todavía no hay cobros.</p>
			) : (
				<div className="card divide-y divide-border">
					{intents.map((i) => {
						const s = STATUS[i.status];
						return (
							<div key={i.id} className="flex items-center gap-4 px-5 py-3.5">
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="text-[15px] tabular font-medium">
											{Number(i.amount).toLocaleString("en-US", { maximumFractionDigits: 6 })} {i.currency}
										</span>
										<span className={`badge ${s.cls}`}>{s.label}</span>
										{i.mode === "test" && <span className="badge badge-muted">test</span>}
									</div>
									<p className="text-[12px] text-text-faint mt-0.5 truncate">
										<code className="mono">{i.id}</code>
										{i.reference ? ` · ${i.reference}` : ""}
									</p>
								</div>
								<span className="text-[12px] text-text-faint shrink-0">{fmt(i.created_at)}</span>
							</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

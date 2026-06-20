import { useState } from "react";
import useSWR from "swr";
import { sileo } from "sileo";
import { apiFetch } from "../lib/api";
import type { User } from "../lib/firebase";

type ApiKey = {
	id: string;
	prefix: string;
	mode: "test" | "live";
	name: string | null;
	last_used_at: string | null;
	revoked: boolean;
	created_at: string;
};

function fmtDate(iso: string | null) {
	if (!iso) return "—";
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("es", { day: "numeric", month: "short", year: "numeric" });
}

export default function ApiKeys({ user }: { user: User }) {
	const fetcher = (p: string) => apiFetch<{ data: ApiKey[] }>(p, { user });
	const { data, isLoading, mutate } = useSWR("/merchant/keys", fetcher);
	const keys = data?.data ?? [];

	const [mode, setMode] = useState<"test" | "live">("test");
	const [name, setName] = useState("");
	const [creating, setCreating] = useState(false);
	const [fresh, setFresh] = useState<string | null>(null);

	async function create() {
		setCreating(true);
		try {
			const res = await apiFetch<{ key: string }>("/merchant/keys", {
				user,
				method: "POST",
				body: { mode, name: name.trim() || undefined },
			});
			setFresh(res.key);
			setName("");
			mutate();
		} catch (e) {
			sileo.error({ title: "No se pudo crear la clave", description: e instanceof Error ? e.message : undefined });
		} finally {
			setCreating(false);
		}
	}

	async function revoke(id: string) {
		if (!confirm("¿Revocar esta clave? Las integraciones que la usen dejarán de funcionar.")) return;
		try {
			await apiFetch(`/merchant/keys/${id}`, { user, method: "DELETE" });
			mutate();
		} catch (e) {
			sileo.error({ title: "No se pudo revocar", description: e instanceof Error ? e.message : undefined });
		}
	}

	function copy(value: string) {
		navigator.clipboard.writeText(value);
		sileo.success({ title: "Copiado" });
	}

	return (
		<div>
			<header className="mb-7">
				<h1 className="text-[26px] mb-1">API keys</h1>
				<p className="text-[14px] text-text-muted">
					Úsalas como <span className="mono">Authorization: Bearer sk_…</span> para crear cobros desde tu servidor.
				</p>
			</header>

			{/* Create */}
			<div className="card p-5 mb-5 flex flex-col sm:flex-row gap-3 sm:items-end">
				<label className="flex-1">
					<span className="block text-[12px] text-text-faint mb-1.5">Nombre (opcional)</span>
					<input className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Mi tienda — producción" maxLength={60} />
				</label>
				<label className="sm:w-40">
					<span className="block text-[12px] text-text-faint mb-1.5">Modo</span>
					<select className="field" value={mode} onChange={(e) => setMode(e.target.value as "test" | "live")}>
						<option value="test">test (sandbox)</option>
						<option value="live">live (producción)</option>
					</select>
				</label>
				<button onClick={create} disabled={creating} className="btn btn-primary">
					{creating ? "Creando…" : "Crear clave"}
				</button>
			</div>

			{/* Fresh key — shown once */}
			{fresh && (
				<div className="card p-5 mb-5 border-brand-gradient" style={{ borderColor: "transparent" }}>
					<p className="text-[13px] text-text-muted mb-2">
						Copia tu clave ahora. <span className="text-text">No la volveremos a mostrar.</span>
					</p>
					<div className="flex items-center gap-2 bg-bg border border-border rounded-[12px] px-3 py-2.5">
						<code className="mono text-[13px] text-glow-sky break-all flex-1">{fresh}</code>
						<button onClick={() => copy(fresh)} className="btn btn-ghost btn-sm shrink-0">Copiar</button>
					</div>
					<button onClick={() => setFresh(null)} className="btn-text mt-2">Listo, ya la guardé</button>
				</div>
			)}

			{/* List */}
			{isLoading && !data ? (
				<p className="text-[14px] text-text-muted">Cargando…</p>
			) : keys.length === 0 ? (
				<p className="text-[14px] text-text-muted">Aún no tienes claves. Crea una para empezar a integrar.</p>
			) : (
				<div className="card divide-y divide-border">
					{keys.map((k) => (
						<div key={k.id} className="flex items-center gap-4 px-5 py-3.5">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<code className="mono text-[13px] text-text">{k.prefix}…</code>
									<span className={`badge ${k.mode === "live" ? "badge-ok" : "badge-muted"}`}>{k.mode}</span>
									{k.revoked && <span className="badge badge-warn">revocada</span>}
								</div>
								<p className="text-[12px] text-text-faint mt-0.5 truncate">
									{k.name || "Sin nombre"} · creada {fmtDate(k.created_at)} · uso {fmtDate(k.last_used_at)}
								</p>
							</div>
							{!k.revoked && (
								<button onClick={() => revoke(k.id)} className="btn btn-danger btn-sm shrink-0">Revocar</button>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}

import { useState } from "react";
import useSWR from "swr";
import { sileo } from "sileo";
import { apiFetch } from "../lib/api";
import type { User } from "../lib/firebase";

type Endpoint = {
	id: string;
	url: string;
	mode: "test" | "live";
	events: string[] | null;
	status: string;
	created_at: string;
};

export default function Webhooks({ user }: { user: User }) {
	const fetcher = (p: string) => apiFetch<{ data: Endpoint[] }>(p, { user });
	const { data, isLoading, mutate } = useSWR("/merchant/webhooks", fetcher);
	const endpoints = data?.data ?? [];

	const [url, setUrl] = useState("");
	const [mode, setMode] = useState<"test" | "live">("test");
	const [creating, setCreating] = useState(false);
	const [secret, setSecret] = useState<string | null>(null);

	async function create() {
		setCreating(true);
		try {
			const res = await apiFetch<{ secret: string }>("/merchant/webhooks", {
				user,
				method: "POST",
				body: { url: url.trim(), mode },
			});
			setSecret(res.secret);
			setUrl("");
			mutate();
		} catch (e) {
			sileo.error({ title: "No se pudo registrar", description: e instanceof Error ? e.message : undefined });
		} finally {
			setCreating(false);
		}
	}

	async function remove(id: string) {
		if (!confirm("¿Eliminar este endpoint? Dejarás de recibir eventos en esa URL.")) return;
		try {
			await apiFetch(`/merchant/webhooks/${id}`, { user, method: "DELETE" });
			mutate();
		} catch (e) {
			sileo.error({ title: "No se pudo eliminar", description: e instanceof Error ? e.message : undefined });
		}
	}

	function copy(value: string) {
		navigator.clipboard.writeText(value);
		sileo.success({ title: "Copiado" });
	}

	return (
		<div>
			<header className="mb-7">
				<h1 className="text-[26px] mb-1">Webhooks</h1>
				<p className="text-[14px] text-text-muted">
					Te avisamos cuando un cobro cambia de estado. Verifica la firma{" "}
					<span className="mono">Parmelia-Signature</span> con tu secreto.
				</p>
			</header>

			<div className="card p-5 mb-5 flex flex-col sm:flex-row gap-3 sm:items-end">
				<label className="flex-1">
					<span className="block text-[12px] text-text-faint mb-1.5">URL del endpoint</span>
					<input className="field mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://tu-servidor.com/webhooks/parmelia" />
				</label>
				<label className="sm:w-40">
					<span className="block text-[12px] text-text-faint mb-1.5">Modo</span>
					<select className="field" value={mode} onChange={(e) => setMode(e.target.value as "test" | "live")}>
						<option value="test">test</option>
						<option value="live">live</option>
					</select>
				</label>
				<button onClick={create} disabled={creating} className="btn btn-primary">
					{creating ? "Registrando…" : "Registrar"}
				</button>
			</div>

			{secret && (
				<div className="card p-5 mb-5">
					<p className="text-[13px] text-text-muted mb-2">
						Secreto de firma. <span className="text-text">No lo volveremos a mostrar.</span>
					</p>
					<div className="flex items-center gap-2 bg-bg border border-border rounded-[12px] px-3 py-2.5">
						<code className="mono text-[13px] text-glow-sky break-all flex-1">{secret}</code>
						<button onClick={() => copy(secret)} className="btn btn-ghost btn-sm shrink-0">Copiar</button>
					</div>
					<button onClick={() => setSecret(null)} className="btn-text mt-2">Listo, ya lo guardé</button>
				</div>
			)}

			{isLoading && !data ? (
				<p className="text-[14px] text-text-muted">Cargando…</p>
			) : endpoints.length === 0 ? (
				<p className="text-[14px] text-text-muted">Sin endpoints. Registra uno para recibir eventos.</p>
			) : (
				<div className="card divide-y divide-border">
					{endpoints.map((e) => (
						<div key={e.id} className="flex items-center gap-4 px-5 py-3.5">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<code className="mono text-[13px] text-text truncate">{e.url}</code>
									<span className={`badge ${e.mode === "live" ? "badge-ok" : "badge-muted"}`}>{e.mode}</span>
								</div>
								<p className="text-[12px] text-text-faint mt-0.5">
									{e.events && e.events.length ? e.events.join(", ") : "todos los eventos"}
								</p>
							</div>
							<button onClick={() => remove(e.id)} className="btn btn-danger btn-sm shrink-0">Eliminar</button>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

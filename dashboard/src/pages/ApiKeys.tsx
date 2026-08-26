import { useState } from "react";
import useSWR from "swr";
import { sileo } from "../lib/notify";
import { apiFetch, type PaymentModeCapabilities } from "../lib/api";
import { docsUrl } from "../lib/docs";
import type { User } from "../lib/firebase";
import ErrorState from "../components/ErrorState";
import ConfirmDialog from "../components/ConfirmDialog";
import { formatDate } from "../lib/format";

type ApiKey = {
	id: string;
	prefix: string;
	mode: "test" | "live";
	name: string | null;
	last_used_at: string | null;
	revoked: boolean;
	created_at: string;
};

export default function ApiKeys({ user }: { user: User }) {
	const fetcher = (p: string) => apiFetch<{ data: ApiKey[] }>(p, { user });
	const { data, error, isLoading, mutate } = useSWR("/merchant/keys", fetcher);
	const keys = data?.data ?? [];
	const { data: capabilities } = useSWR("/merchant/capabilities",
		(p: string) => apiFetch<PaymentModeCapabilities>(p, { user }));
	const liveEnabled = capabilities?.modes.live.enabled === true;

	const [mode, setMode] = useState<"test" | "live">("test");
	const [name, setName] = useState("");
	const [creating, setCreating] = useState(false);
	const [fresh, setFresh] = useState<string | null>(null);
	// Pending confirmations (in-design dialogs instead of native confirm()).
	const [confirmLive, setConfirmLive] = useState(false);
	const [revokeTarget, setRevokeTarget] = useState<ApiKey | null>(null);

	async function doCreate() {
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

	// Live keys move real money: one deliberate extra step before creating.
	function create() {
		if (mode === "live") {
			if (!liveEnabled) {
				sileo.error({ title: "Modo live no disponible",
					description: "La liquidación real seguirá bloqueada hasta habilitar y verificar las redes mainnet." });
				return;
			}
			setConfirmLive(true);
			return;
		}
		void doCreate();
	}

	async function doRevoke(id: string) {
		try {
			await apiFetch(`/merchant/keys/${id}`, { user, method: "DELETE" });
			mutate();
		} catch (e) {
			sileo.error({ title: "No se pudo revocar", description: e instanceof Error ? e.message : undefined });
		}
	}

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
				<h1 className="text-[26px] mb-1">API keys</h1>
				<p className="text-[14px] text-text-muted">
					Úsalas como <span className="mono">Authorization: Bearer sk_…</span> para crear cobros desde tu servidor.{" "}
					<a href={docsUrl("authentication")} target="_blank" rel="noopener noreferrer" className="text-glow-sky">
						Ver autenticación en la doc
					</a>
				</p>
			</header>

			{/* Create */}
			<form
				className="card p-5 mb-5 flex flex-col sm:flex-row gap-3 sm:items-end"
				onSubmit={(event) => {
					event.preventDefault();
					create();
				}}
			>
				<label className="flex-1">
					<span className="block text-[12px] text-text-faint mb-1.5">Nombre (opcional)</span>
					<input
						className="field"
						name="key_name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Ej. Mi tienda — producción"
						maxLength={60}
						autoComplete="off"
						spellCheck={false}
					/>
				</label>
				<label className="sm:w-40">
					<span className="block text-[12px] text-text-faint mb-1.5">Modo</span>
					<select name="mode" className="field" value={mode} onChange={(e) => setMode(e.target.value as "test" | "live")}>
						<option value="test">test (sandbox)</option>
						<option value="live" disabled={!liveEnabled}>live (aún no disponible)</option>
					</select>
				</label>
				<button type="submit" disabled={creating} className="btn btn-primary">
					{creating ? "Creando…" : "Crear clave"}
				</button>
			</form>
			{!liveEnabled && (
				<p className="text-[12px] text-text-faint -mt-3 mb-5">
					Solo testnet está habilitado. El backend rechazará claves live hasta que existan rutas mainnet verificadas.
				</p>
			)}

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
			) : error && !data ? (
				<ErrorState message={error instanceof Error ? error.message : undefined} onRetry={() => mutate()} />
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
									{k.name || "Sin nombre"} · creada {formatDate(k.created_at)} · uso {formatDate(k.last_used_at)}
								</p>
							</div>
							{!k.revoked && (
								<button onClick={() => setRevokeTarget(k)} className="btn btn-danger btn-sm shrink-0">Revocar</button>
							)}
						</div>
					))}
				</div>
			)}

			{confirmLive && (
				<ConfirmDialog
					title="Crear clave live"
					body={
						<>
							Las claves <span className="mono">sk_live_</span> crean cobros con dinero real en Arbitrum One,
							liquidados directo a tu cuenta. Guárdala solo en tu servidor y revócala de inmediato si se filtra.
						</>
					}
					confirmLabel="Crear clave live"
					onConfirm={() => {
						setConfirmLive(false);
						void doCreate();
					}}
					onCancel={() => setConfirmLive(false)}
				/>
			)}

			{revokeTarget && (
				<ConfirmDialog
					title="Revocar clave"
					body={
						<>
							Vas a revocar <span className="mono">{revokeTarget.prefix}…</span>
							{revokeTarget.name ? <> ({revokeTarget.name})</> : null}. Las integraciones que la usen dejarán de
							funcionar al instante. Esta acción no se puede deshacer.
						</>
					}
					confirmLabel="Revocar"
					danger
					onConfirm={() => {
						const id = revokeTarget.id;
						setRevokeTarget(null);
						void doRevoke(id);
					}}
					onCancel={() => setRevokeTarget(null)}
				/>
			)}
		</div>
	);
}

import { useState } from "react";
import useSWR from "swr";
import { sileo } from "../lib/notify";
import { apiFetch } from "../lib/api";
import { docsUrl } from "../lib/docs";
import type { User } from "../lib/firebase";
import ErrorState from "../components/ErrorState";
import ConfirmDialog from "../components/ConfirmDialog";

// Contextual copy of the verification snippet from the canonical docs
// (the GatoPago docs, #verifying-the-signature) - shown next to the secret on
// purpose: it appears at the exact moment the developer needs it. The signing
// scheme is HMAC-SHA256(secret, "<GatoPago-Timestamp>.<raw body>").
const VERIFY_SNIPPET = `import crypto from "node:crypto";

// Express: monta la ruta con express.raw({ type: "application/json" })
// para tener el cuerpo CRUDO (la firma es sobre los bytes exactos).
function verifyGatoPago(req, secret) {
  const timestamp = req.header("GatoPago-Timestamp");
  const signature = req.header("GatoPago-Signature");
  if (!timestamp || !signature) return false;

  // Rechaza timestamps viejos (anti-replay, tolerancia 5 min).
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;

  const expected = crypto
    .createHmac("sha256", secret) // tu whsec_...
    .update(\`\${timestamp}.\${req.body}\`)
    .digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}`;

type Endpoint = {
	id: string;
	url: string;
	mode: "test" | "live";
	events: string[] | null;
	status: string;
	created_at: string;
};

type Delivery = {
	id: string;
	eventType: string;
	url: string;
	status: string;
	attempt: number;
	responseCode: number | null;
	createdAt: string;
	deliveredAt: string | null;
};

export default function Webhooks({ user }: { user: User }) {
	const fetcher = (p: string) => apiFetch<{ data: Endpoint[] }>(p, { user });
	const { data, error, isLoading, mutate } = useSWR("/merchant/webhooks", fetcher);
	const endpoints = data?.data ?? [];

	const delFetcher = (p: string) => apiFetch<{ data: Delivery[] }>(p, { user });
	const { data: delData, error: delError, mutate: mutateDel } = useSWR("/merchant/webhook_deliveries", delFetcher, {
		refreshInterval: 5000,
	});
	const deliveries = delData?.data ?? [];

	const [url, setUrl] = useState("");
	const [mode, setMode] = useState<"test" | "live">("test");
	const [creating, setCreating] = useState(false);
	const [secret, setSecret] = useState<string | null>(null);
	const [removeTarget, setRemoveTarget] = useState<Endpoint | null>(null);

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

	async function doRemove(id: string) {
		try {
			await apiFetch(`/merchant/webhooks/${id}`, { user, method: "DELETE" });
			mutate();
		} catch (e) {
			sileo.error({ title: "No se pudo eliminar", description: e instanceof Error ? e.message : undefined });
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

	async function resend(id: string) {
		try {
			await apiFetch(`/merchant/webhook_deliveries/${id}/resend`, { user, method: "POST" });
			mutateDel();
			sileo.success({ title: "Reencolado" });
		} catch (e) {
			sileo.error({ title: "No se pudo reenviar", description: e instanceof Error ? e.message : undefined });
		}
	}

	return (
		<div>
			<header className="mb-7">
				<h1 className="text-[26px] mb-1">Webhooks</h1>
				<p className="text-[14px] text-text-muted">
					Te avisamos cuando un cobro cambia de estado. Verifica la firma{" "}
					<span className="mono">GatoPago-Signature</span> con tu secreto.
				</p>
			</header>

			<form
				className="card p-5 mb-5 flex flex-col sm:flex-row gap-3 sm:items-end"
				onSubmit={(event) => {
					event.preventDefault();
					void create();
				}}
			>
				<label className="flex-1">
					<span className="block text-[12px] text-text-faint mb-1.5">URL del endpoint</span>
					<input
						className="field mono"
						type="url"
						name="endpoint_url"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						placeholder="https://tu-servidor.com/webhooks/gatopago"
						autoComplete="url"
						spellCheck={false}
						required
					/>
				</label>
				<label className="sm:w-40">
					<span className="block text-[12px] text-text-faint mb-1.5">Modo</span>
					<select name="mode" className="field" value={mode} onChange={(e) => setMode(e.target.value as "test" | "live")}>
						<option value="test">test</option>
						<option value="live">live</option>
					</select>
				</label>
				<button type="submit" disabled={creating} className="btn btn-primary">
					{creating ? "Registrando…" : "Registrar"}
				</button>
			</form>

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

			{/* How to verify - collapsible, lives next to where the secret is issued */}
			<details className="card mb-5 group">
				<summary className="px-5 py-4 cursor-pointer list-none flex items-center justify-between text-[14px] text-text hover:bg-surface-2 transition-colors rounded-[inherit]">
					Cómo verificar la firma en tu servidor
					<span className="text-text-faint text-[12px] group-open:hidden">ver</span>
					<span className="text-text-faint text-[12px] hidden group-open:inline">ocultar</span>
				</summary>
				<div className="px-5 pb-5">
					<p className="text-[13px] text-text-muted mb-3 leading-relaxed">
						Cada entrega llega con <span className="mono">GatoPago-Signature</span> (HMAC-SHA256 en hex),{" "}
						<span className="mono">GatoPago-Timestamp</span> (unix, segundos) y{" "}
						<span className="mono">GatoPago-Event-Id</span>. La firma se calcula sobre{" "}
						<span className="mono">{"<timestamp>.<cuerpo crudo>"}</span> con tu secreto{" "}
						<span className="mono">whsec_</span>. Verifica SIEMPRE antes de procesar.
					</p>
					<div className="relative">
						<pre className="bg-bg border border-border rounded-[12px] p-3 overflow-x-auto text-[12px] mono text-text-muted leading-relaxed">{VERIFY_SNIPPET}</pre>
						<button onClick={() => copy(VERIFY_SNIPPET)} className="btn btn-ghost btn-sm absolute top-2 right-2">
							Copiar
						</button>
					</div>
					<p className="text-[13px] text-text-muted mt-3">
						Guía completa (con más lenguajes) en la{" "}
						<a href={docsUrl("verifying-the-signature")} target="_blank" rel="noopener noreferrer" className="text-glow-sky">
							documentación
						</a>.
					</p>
				</div>
			</details>

			{isLoading && !data ? (
				<p className="text-[14px] text-text-muted">Cargando…</p>
			) : error && !data ? (
				<ErrorState message={error instanceof Error ? error.message : undefined} onRetry={() => mutate()} />
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
							<button onClick={() => setRemoveTarget(e)} className="btn btn-danger btn-sm shrink-0">Eliminar</button>
						</div>
					))}
				</div>
			)}

			{/* Delivery log */}
			<div className="mt-8">
				<h2 className="text-[18px] mb-1">Entregas recientes</h2>
				<p className="text-[13px] text-text-muted mb-4">Últimos intentos de envío a tus endpoints (se reintentan con backoff).</p>
				{delError && !delData ? (
					<ErrorState message={delError instanceof Error ? delError.message : undefined} onRetry={() => mutateDel()} />
				) : deliveries.length === 0 ? (
					<p className="text-[14px] text-text-muted">Aún no hay entregas. Usa el Sandbox para disparar un evento de prueba.</p>
				) : (
					<div className="card divide-y divide-border">
						{deliveries.map((d) => (
							<div key={d.id} className="flex items-center gap-3 px-5 py-3">
								<span className={`badge ${d.status === "delivered" ? "badge-ok" : "badge-muted"}`}>{d.status}</span>
								<div className="min-w-0 flex-1">
									<div className="flex items-center gap-2">
										<span className="mono text-[13px] text-text">{d.eventType}</span>
										{d.responseCode != null && <span className="text-[12px] text-text-faint">HTTP {d.responseCode}</span>}
									</div>
									<code className="mono text-[12px] text-text-faint truncate block">{d.url}</code>
								</div>
								<span className="text-[12px] text-text-faint shrink-0 hidden sm:block">intento {d.attempt}</span>
								{d.status !== "delivered" && (
									<button onClick={() => resend(d.id)} className="btn btn-ghost btn-sm shrink-0">Reenviar</button>
								)}
							</div>
						))}
					</div>
				)}
			</div>

			{removeTarget && (
				<ConfirmDialog
					title="Eliminar endpoint"
					body={
						<>
							Dejarás de recibir eventos en <code className="mono">{removeTarget.url}</code>. Las entregas
							pendientes hacia esa URL se descartan.
						</>
					}
					confirmLabel="Eliminar"
					danger
					onConfirm={() => {
						const id = removeTarget.id;
						setRemoveTarget(null);
						void doRemove(id);
					}}
					onCancel={() => setRemoveTarget(null)}
				/>
			)}
		</div>
	);
}

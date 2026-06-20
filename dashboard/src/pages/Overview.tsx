import useSWR from "swr";
import { Link } from "react-router-dom";
import { apiFetch, SERVER_URL } from "../lib/api";
import type { User } from "../lib/firebase";

export default function Overview({ user }: { user: User }) {
	const fetcher = (p: string) => apiFetch<{ data: unknown[] }>(p, { user });
	const { data: keys } = useSWR("/merchant/keys", fetcher);
	const { data: hooks } = useSWR("/merchant/webhooks", fetcher);
	const keyCount = keys?.data?.length ?? 0;
	const hookCount = hooks?.data?.length ?? 0;

	const curl = `curl -X POST ${SERVER_URL}/v1/payment_intents \\
  -H "Authorization: Bearer sk_test_…" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":"25.00","currency":"USDC","metadata":{"order_id":"A-1042"}}'`;

	return (
		<div>
			<header className="mb-7">
				<h1 className="text-[26px] mb-1">
					Empieza a <span className="text-brand-gradient">cobrar</span>
				</h1>
				<p className="text-[14px] text-text-muted">Integra cobros en stablecoins en tres pasos.</p>
			</header>

			{/* Counts */}
			<div className="grid grid-cols-2 gap-3 mb-6 max-w-sm">
				<Link to="/keys" className="card p-4 hover:border-border-strong transition-colors">
					<p className="font-display text-[28px] tabular">{keyCount}</p>
					<p className="text-[13px] text-text-muted">API keys</p>
				</Link>
				<Link to="/webhooks" className="card p-4 hover:border-border-strong transition-colors">
					<p className="font-display text-[28px] tabular">{hookCount}</p>
					<p className="text-[13px] text-text-muted">Webhooks</p>
				</Link>
			</div>

			{/* Quickstart */}
			<div className="card p-6 mb-5">
				<ol className="flex flex-col gap-4">
					<li className="flex gap-3">
						<span className="badge badge-ok shrink-0">1</span>
						<div>
							<p className="text-[15px]">Crea una API key</p>
							<p className="text-[13px] text-text-muted">En <Link to="/keys" className="text-glow-sky">API keys</Link>. Empieza con una clave <span className="mono">test</span>.</p>
						</div>
					</li>
					<li className="flex gap-3">
						<span className="badge badge-ok shrink-0">2</span>
						<div className="min-w-0 flex-1">
							<p className="text-[15px] mb-2">Crea un cobro</p>
							<pre className="bg-bg border border-border rounded-[12px] p-3 overflow-x-auto text-[12px] mono text-text-muted leading-relaxed">{curl}</pre>
							<p className="text-[13px] text-text-muted mt-2">Te devuelve un <span className="mono">checkout_url</span> (link o QR) para compartir.</p>
						</div>
					</li>
					<li className="flex gap-3">
						<span className="badge badge-ok shrink-0">3</span>
						<div>
							<p className="text-[15px]">Recibe el webhook</p>
							<p className="text-[13px] text-text-muted">Registra tu URL en <Link to="/webhooks" className="text-glow-sky">Webhooks</Link>. Al pagar, te llega <span className="mono">payment.paid</span> firmado.</p>
						</div>
					</li>
				</ol>
			</div>

			<p className="text-[13px] text-text-faint">
				¿Solo pruebas? Crea un cobro y márcalo como pagado con{" "}
				<span className="mono">POST /v1/payment_intents/:id/simulate_payment</span> (claves test) para ver el webhook al instante.
			</p>
		</div>
	);
}

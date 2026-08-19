import { useState } from "react";
import { Link } from "react-router";
import { sileo } from "sileo";
import { apiFetch } from "../lib/api";
import { docsUrl } from "../lib/docs";
import type { User } from "../lib/firebase";

type Intent = { id: string; status: string; amount: string; currency: string };

export default function Sandbox({ user }: { user: User }) {
	const [amount, setAmount] = useState("25.00");
	const [reference, setReference] = useState("");
	const [intent, setIntent] = useState<Intent | null>(null);
	const [busy, setBusy] = useState(false);

	async function createCharge() {
		setBusy(true);
		try {
			const res = await apiFetch<Intent>("/merchant/sandbox/charge", {
				user,
				method: "POST",
				body: { amount: amount.trim(), reference: reference.trim() || undefined },
			});
			setIntent(res);
			sileo.success({ title: "Cobro de prueba creado" });
		} catch (e) {
			sileo.error({ title: "No se pudo crear", description: e instanceof Error ? e.message : undefined });
		} finally {
			setBusy(false);
		}
	}

	async function simulate() {
		if (!intent) return;
		setBusy(true);
		try {
			const res = await apiFetch<Intent>(`/merchant/sandbox/simulate/${intent.id}`, { user, method: "POST" });
			setIntent(res);
			sileo.success({ title: "Pago simulado", description: "Revisa Eventos y tu endpoint: payment.paid" });
		} catch (e) {
			sileo.error({ title: "No se pudo simular", description: e instanceof Error ? e.message : undefined });
		} finally {
			setBusy(false);
		}
	}

	return (
		<div>
			<header className="mb-7">
				<h1 className="text-[26px] mb-1">Sandbox</h1>
				<p className="text-[14px] text-text-muted">
					Crea un cobro de prueba y simula su pago para ver tus webhooks, sin dinero real ni cadena.
				</p>
			</header>

			<form
				className="card p-5 mb-5 flex flex-col sm:flex-row gap-3 sm:items-end max-w-2xl"
				onSubmit={(event) => {
					event.preventDefault();
					void createCharge();
				}}
			>
				<label className="sm:w-40">
					<span className="block text-[12px] text-text-faint mb-1.5">Monto (USDC)</span>
					<input
						className="field"
						name="amount"
						value={amount}
						onChange={(e) => setAmount(e.target.value)}
						inputMode="decimal"
						autoComplete="off"
						spellCheck={false}
						required
					/>
				</label>
				<label className="flex-1">
					<span className="block text-[12px] text-text-faint mb-1.5">Referencia (opcional)</span>
					<input
						className="field"
						name="reference"
						value={reference}
						onChange={(e) => setReference(e.target.value)}
						placeholder="Pedido #A-1042"
						autoComplete="off"
					/>
				</label>
				<button type="submit" disabled={busy} className="btn btn-primary">
					Crear cobro de prueba
				</button>
			</form>

			{intent && (
				<div className="card p-5 max-w-2xl">
					<div className="flex items-center gap-2 mb-3">
						<code className="mono text-[13px] text-text">{intent.id}</code>
						<span className={`badge ${intent.status === "paid" ? "badge-ok" : "badge-muted"}`}>{intent.status}</span>
						<span className="badge badge-muted">test</span>
					</div>
					<p className="text-[14px] text-text-muted mb-4">
						{intent.amount} {intent.currency}
					</p>
					{intent.status === "awaiting_payment" ? (
						<button onClick={simulate} disabled={busy} className="btn btn-gradient">
							Simular pago
						</button>
					) : (
						<p className="text-[13px] text-text-muted">
							Pagado. Revisa <Link to="/events" className="text-glow-sky">Eventos</Link> y tu endpoint: llegó{" "}
							<span className="mono">payment.paid</span> firmado.
						</p>
					)}
				</div>
			)}

			<p className="text-[13px] text-text-faint mt-5 max-w-2xl">
				El sandbox usa modo <span className="mono">test</span>: no mueve fondos ni toca la blockchain. Sirve para validar
				tu integración (crear cobro → recibir webhook firmado) antes de ir a producción. Más detalle en la{" "}
				<a href={docsUrl("test-mode--sandbox")} target="_blank" rel="noopener noreferrer" className="text-glow-sky">
					documentación
				</a>.
			</p>
		</div>
	);
}

import type { ReactNode } from "react";
import useSWR from "swr";
import { Link, useParams } from "react-router";
import { QRCodeSVG } from "qrcode.react";
import { sileo } from "../lib/notify";
import { ApiError, apiFetch } from "../lib/api";
import type { User } from "../lib/firebase";
import ErrorState from "../components/ErrorState";
import { formatAmount, formatDateTime } from "../lib/format";

type OnchainAuth = {
	router: string;
	chainId: number;
	invoiceId: string;
	token: string;
	amount: string;
	merchant: string;
	feeBps: number;
	deadline: number;
	signature: string;
	call: { function: string; args: string };
	callWithPermit: { function: string; args: string };
};

type Detail = {
	id: string;
	status: string;
	amount: string;
	currency: string;
	reference: string | null;
	tx_hash: string | null;
	mode: "test" | "live";
	created_at: string;
	checkout_url: string | null;
	onchain: OnchainAuth | null;
};

async function copy(value: string) {
	try {
		await navigator.clipboard.writeText(value);
		sileo.success({ title: "Copiado" });
	} catch {
		sileo.error({ title: "No se pudo copiar", description: "Copia el valor manualmente." });
	}
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="flex items-start justify-between gap-4 py-2.5 border-b border-border last:border-0">
			<span className="text-[13px] text-text-muted shrink-0">{label}</span>
			<span className="text-[13px] text-text text-right break-all">{children}</span>
		</div>
	);
}

export default function PaymentDetail({ user }: { user: User }) {
	const { id = "" } = useParams();
	const { data, isLoading, error, mutate } = useSWR(
		id ? `/merchant/payment_intents/${id}` : null,
		(p: string) => apiFetch<Detail>(p, { user }),
		{ refreshInterval: 10000 },
	);
	const notFound = error instanceof ApiError && error.status === 404;

	return (
		<div>
			<header className="mb-6">
				<Link to="/payments" className="text-[13px] text-glow-sky">← Pagos</Link>
				<h1 className="text-[24px] mt-2">Detalle del cobro</h1>
			</header>

			{isLoading && !data ? (
				<p className="text-[14px] text-text-muted">Cargando…</p>
			) : notFound ? (
				<p className="text-[14px] text-text-muted">No se encontró el cobro.</p>
			) : error && !data ? (
				<div className="max-w-2xl">
					<ErrorState message={error instanceof Error ? error.message : undefined} onRetry={() => mutate()} />
				</div>
			) : !data ? (
				<p className="text-[14px] text-text-muted">No se encontró el cobro.</p>
			) : (
				<div className="flex flex-col gap-5 max-w-2xl">
					<div className="card p-5">
						<div className="flex items-center gap-2 mb-4">
							<span className="font-display text-[28px] tabular">
								{formatAmount(data.amount)} {data.currency}
							</span>
							<span className={`badge ${data.status === "paid" ? "badge-ok" : "badge-muted"}`}>{data.status}</span>
							{data.mode === "test" && <span className="badge badge-muted">test</span>}
						</div>
						<Row label="ID">
							<code className="mono">{data.id}</code>
						</Row>
						{data.reference && <Row label="Referencia">{data.reference}</Row>}
						<Row label="Creado">{formatDateTime(data.created_at)}</Row>
						{data.tx_hash && (
							<Row label="Tx">
								<code className="mono">{data.tx_hash}</code>
							</Row>
						)}
						{data.checkout_url && (
							<Row label="Checkout">
								<button onClick={() => copy(data.checkout_url!)} className="text-glow-sky">{data.checkout_url}</button>
							</Row>
						)}
					</div>

					{/* Cobrar en persona: the checkout as QR while it can still be paid */}
					{data.checkout_url && data.status === "awaiting_payment" && (
						<div className="card p-5">
							<h2 className="text-[16px] mb-1">Cobrar en persona</h2>
							<p className="text-[13px] text-text-muted mb-4">
								Muestra este QR al cliente o comparte el link del checkout.
							</p>
							<div className="flex flex-col sm:flex-row items-center gap-5">
								<div className="p-3 bg-white rounded-2xl shrink-0">
									<QRCodeSVG value={data.checkout_url} size={160} bgColor="#ffffff" fgColor="#0A0A0B" level="M" />
								</div>
								<div className="flex flex-col gap-2 w-full min-w-0">
									<code className="mono text-[12px] text-text-faint break-all">{data.checkout_url}</code>
									<div className="flex gap-2">
										<a
											href={data.checkout_url}
											target="_blank"
											rel="noopener noreferrer"
											className="btn btn-primary btn-sm"
										>
											Abrir checkout
										</a>
										<button onClick={() => copy(data.checkout_url!)} className="btn btn-ghost btn-sm">
											Copiar link
										</button>
									</div>
								</div>
							</div>
						</div>
					)}

					{/* Flow B: on-chain authorization for an external wallet */}
					{data.onchain ? (
						<div className="card p-5">
							<div className="flex items-center justify-between mb-2">
								<h2 className="text-[16px]">Pago on-chain (Flow B)</h2>
								<button onClick={() => copy(JSON.stringify(data.onchain, null, 2))} className="btn btn-ghost btn-sm">
									Copiar JSON
								</button>
							</div>
							<p className="text-[13px] text-text-muted mb-3">
								Autorización firmada para que cualquier wallet pague vía el PaymentRouter. Llama{" "}
								<span className="mono">payInvoice</span> con estos datos (o <span className="mono">payInvoiceWithPermit</span>{" "}
								para pagar en 1 tx con permit EIP-2612).
							</p>
							<Row label="Router">
								<code className="mono">{data.onchain.router}</code>
							</Row>
							<Row label="invoiceId">
								<code className="mono">{data.onchain.invoiceId}</code>
							</Row>
							<Row label="amount (atomic)">{data.onchain.amount}</Row>
							<Row label="feeBps">{data.onchain.feeBps}</Row>
							<Row label="deadline">{data.onchain.deadline}</Row>
							<Row label="signature">
								<code className="mono">{`${data.onchain.signature.slice(0, 14)}…`}</code>
							</Row>
						</div>
					) : (
						<p className="text-[13px] text-text-faint">
							El pago on-chain (Flow B) aparece aquí cuando el router está configurado y el cobro está pendiente.
						</p>
					)}
				</div>
			)}
		</div>
	);
}

import { useSyncExternalStore } from "react";
import {
	getToasts,
	removeToast,
	subscribeToasts,
	type ToastKind,
} from "../lib/toastStore";

function StatusIcon({ kind }: { kind: ToastKind }) {
	return (
		<span
			aria-hidden="true"
			className={`flex h-6 w-6 items-center justify-center rounded-sm text-[12px] font-semibold ${
				kind === "success"
					? "bg-sky/15 text-glow-sky"
					: "bg-danger/15 text-danger"
			}`}
		>
			{kind === "success" ? "✓" : "!"}
		</span>
	);
}

export default function ToastViewport() {
	const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);

	return (
		<section
			aria-label="Notificaciones"
			aria-live="polite"
			className="pointer-events-none fixed inset-x-0 top-4 z-[80] flex flex-col items-center gap-2 px-4"
		>
			{toasts.map((toast) => (
				<div
					key={toast.id}
					role={toast.kind === "error" ? "alert" : "status"}
					className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-md border border-border-strong bg-surface-2 px-4 py-3 shadow-e1 animate-fade-up"
				>
					<span className="mt-0.5 shrink-0">
						<StatusIcon kind={toast.kind} />
					</span>
					<div className="min-w-0 flex-1">
						<p className="text-[13px] font-semibold leading-snug text-text">{toast.title}</p>
						{toast.description ? (
							<p className="mt-0.5 text-[12px] leading-relaxed text-text-muted">
								{toast.description}
							</p>
						) : null}
					</div>
					<button
						type="button"
						onClick={() => removeToast(toast.id)}
						aria-label="Cerrar notificación"
						className="-mr-2 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-faint hover:text-text"
					>
						<span aria-hidden="true">×</span>
					</button>
				</div>
			))}
		</section>
	);
}

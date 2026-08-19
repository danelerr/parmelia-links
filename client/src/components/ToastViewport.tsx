import { useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { getToasts, removeToast, subscribeToasts, type ToastKind } from "../lib/toastStore";

function StatusIcon({ kind }: { kind: ToastKind }) {
	if (kind === "loading") {
		return <span className="h-4 w-4 rounded-[4px] border-2 border-border border-t-cat-500 animate-spin" />;
	}
	const tones = {
		success: "bg-growth/14 text-growth",
		warning: "bg-pending/14 text-pending",
		error: "bg-danger/14 text-danger",
	} as const;
	return (
		<span className={`flex h-6 w-6 items-center justify-center rounded-[8px] text-[12px] font-semibold ${tones[kind]}`}>
			{kind === "success" ? "✓" : "!"}
		</span>
	);
}

export default function ToastViewport() {
	const { t } = useTranslation();
	const toasts = useSyncExternalStore(subscribeToasts, getToasts, getToasts);

	return (
		<section
			aria-label={t("common.notifications")}
			aria-live="polite"
			className="fixed z-[80] inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] px-4 flex flex-col items-center gap-2 pointer-events-none"
		>
			{toasts.map((toast) => (
				<div
					key={toast.id}
					role={toast.kind === "error" ? "alert" : "status"}
					className="pointer-events-auto flex w-full max-w-sm items-start gap-3 border-2 border-text bg-surface px-4 py-3 shadow-[7px_7px_0_var(--color-cat-700)] animate-pixel-in"
				>
					<span className="mt-0.5 shrink-0"><StatusIcon kind={toast.kind} /></span>
					<div className="min-w-0 flex-1">
						<p className="text-[13px] text-text font-medium leading-snug">{toast.title}</p>
						{toast.description ? (
							<p className="text-[12px] text-text-muted leading-relaxed mt-0.5">{toast.description}</p>
						) : null}
						{toast.action ? (
							<button
								onClick={() => {
									removeToast(toast.id);
									toast.action?.onClick();
								}}
								className="mt-2 text-[12px] font-semibold text-cat-300 underline underline-offset-2"
							>
								{toast.action.title}
							</button>
						) : null}
					</div>
					<button
						onClick={() => removeToast(toast.id)}
						aria-label={t("common.close")}
						className="-mr-2 -mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-faint"
					>
						<span aria-hidden="true">×</span>
					</button>
				</div>
			))}
		</section>
	);
}

// In-design confirmation modal, replacing the browser-native confirm() for
// destructive or consequential actions (revoke key, delete endpoint, create a
// live key). Mount it conditionally; Escape and backdrop click cancel.

import { useEffect, useRef, type ReactNode } from "react";

export default function ConfirmDialog({
	title,
	body,
	confirmLabel,
	danger = false,
	onConfirm,
	onCancel,
}: {
	title: string;
	body: ReactNode;
	confirmLabel: string;
	/** true = destructive styling on the confirm button. */
	danger?: boolean;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const cancelRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		cancelRef.current?.focus();
		function onKey(e: KeyboardEvent) {
			if (e.key === "Escape") onCancel();
		}
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onCancel]);

	return (
		<div
			className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center px-5 animate-fade-in"
			onClick={onCancel}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-labelledby="confirm-dialog-title"
				className="w-full max-w-sm card p-6"
				onClick={(e) => e.stopPropagation()}
			>
				<h2 id="confirm-dialog-title" className="text-[17px] mb-2">
					{title}
				</h2>
				<div className="text-[13px] text-text-muted leading-relaxed mb-5">{body}</div>
				<div className="flex gap-2 justify-end">
					<button ref={cancelRef} onClick={onCancel} className="btn btn-ghost btn-sm">
						Cancelar
					</button>
					<button onClick={onConfirm} className={`btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`}>
						{confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}

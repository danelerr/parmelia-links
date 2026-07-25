// The one confirm-before-signing bottom sheet (R-4 in UX_DESIGN.md): every
// operation that moves money confirms through this exact surface, so the
// moment before the biometric prompt always looks the same. Detail rows
// (destination, fees, notes) go in children, between the amount and the
// warning.

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDialog } from "../hooks/useDialog";
import Logo from "./Logo";

export default function ConfirmSheet({
	title,
	amountLabel,
	amount,
	unit,
	warning,
	confirmLabel,
	onConfirm,
	onCancel,
	children,
}: {
	title: string;
	amountLabel?: string;
	amount: string;
	unit: string;
	warning?: string;
	confirmLabel: string;
	onConfirm: () => void;
	onCancel: () => void;
	children?: ReactNode;
}) {
	const { t } = useTranslation();
	const dialogRef = useDialog<HTMLDivElement>(onCancel);
	// Portal to <body>: page containers keep a persistent transform from their
	// entrance animation, which would trap this fixed overlay and anchor it to
	// the document instead of the viewport.
	return createPortal(
		<div
			className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end justify-center px-5 animate-fade-in"
			style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
			onClick={onCancel}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="confirm-sheet-title"
				tabIndex={-1}
				className="w-full max-w-sm bg-surface border border-border rounded-[24px] p-6 shadow-e3 animate-fade-up"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="flex items-center justify-center gap-2 mb-5">
					<Logo className="w-6" />
					<span id="confirm-sheet-title" className="text-[13px] text-text-muted">
						{title}
					</span>
				</div>
				{amountLabel && <p className="text-[13px] text-text-muted text-center mb-1">{amountLabel}</p>}
				<p className="font-display text-[40px] leading-tight tabular text-center mb-5 max-w-full break-words">
					{amount}
					<span className="text-text-muted text-[20px] ml-1.5">{unit}</span>
				</p>
				{children}
				{/* Trust line (UX_DESIGN §6bis): every money confirmation carries it. */}
				<p className="text-[12px] text-glow-sky text-center mb-2 leading-relaxed">
					{t("common.trustLine")}
				</p>
				{warning && (
					<p className="text-[12px] text-text-faint text-center mb-5 leading-relaxed">{warning}</p>
				)}
				<button onClick={onConfirm} className="btn btn-gradient btn-block">
					{confirmLabel}
				</button>
				<button onClick={onCancel} className="btn-text w-full mt-1">
					{t("common.cancel")}
				</button>
			</div>
		</div>,
		document.body,
	);
}

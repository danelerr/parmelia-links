// The one confirm-before-signing bottom sheet (R-4 in UX_DESIGN.md): every
// operation that moves money confirms through this exact surface, so the
// moment before the biometric prompt always looks the same. Detail rows
// (destination, fees, notes) go in children, between the amount and the
// warning.

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDialog } from "../hooks/useDialog";
import CatGlyph from "./brand/CatGlyph";

export default function ConfirmSheet({
	title,
	amountLabel,
	amount,
	unit,
	warning,
	confirmLabel,
	paymentAction = false,
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
	paymentAction?: boolean;
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
			className="dialog-backdrop fixed inset-0 z-50 flex items-end justify-center px-5 animate-fade-in"
			style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
			onClick={onCancel}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="confirm-sheet-title"
				tabIndex={-1}
				className="dialog-panel max-h-[min(88dvh,720px)] w-full max-w-sm overflow-y-auto overscroll-contain p-6 animate-sheet-up"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="sheet-handle mb-5" aria-hidden="true" />
				<h2 id="confirm-sheet-title" className="meli-kicker mb-5">{title}</h2>
				<div className="mb-5 flex items-center gap-4 bg-[#0b0b0f] p-4 text-[#fff8f0]">
					<CatGlyph className="w-14 shrink-0" />
					<div className="min-w-0">
						{amountLabel && <p className="mb-1 text-[11px] text-[rgb(255_248_240/.56)]">{amountLabel}</p>}
						<p className="type-mono max-w-full break-words text-[32px] font-bold leading-tight">
							{amount}
							<span className="ml-1.5 text-[15px] text-[rgb(255_248_240/.58)]">{unit}</span>
						</p>
					</div>
				</div>
				{children}
				{/* Trust line (UX_DESIGN §6bis): every money confirmation carries it. */}
				<p className="mb-2 border-l-4 border-info bg-info/8 px-3 py-2 text-[12px] leading-relaxed text-info">
					{t("common.trustLine")}
				</p>
				{warning && (
					<p className="text-[12px] text-text-faint text-center mb-5 leading-relaxed">{warning}</p>
				)}
				<button type="button" onClick={onConfirm} className={`btn btn-block ${paymentAction ? "btn-money" : "btn-primary"}`}>
					{confirmLabel}
				</button>
				<button type="button" onClick={onCancel} className="btn-text w-full mt-1">
					{t("common.cancel")}
				</button>
			</div>
		</div>,
		document.body,
	);
}

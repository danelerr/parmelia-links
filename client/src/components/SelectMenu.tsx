import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDialog } from "../hooks/useDialog";

export type SelectMenuValue = string | number;

export type SelectMenuOption<T extends SelectMenuValue> = {
	value: T;
	label: string;
	description?: string;
	tone?: "brand" | "growth" | "info" | "pending" | "danger";
	icon?: ReactNode;
	disabled?: boolean;
};

export default function SelectMenu<T extends SelectMenuValue>({
	label,
	value,
	options,
	onChange,
	placeholder,
	name,
	showLabel = true,
	compact = false,
	disabled = false,
	required = false,
	className = "",
}: {
	label: string;
	value: T | null;
	options: SelectMenuOption<T>[];
	onChange: (value: T) => void;
	placeholder?: string;
	name?: string;
	showLabel?: boolean;
	compact?: boolean;
	disabled?: boolean;
	required?: boolean;
	className?: string;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const titleId = useId();
	const valueId = useId();
	const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
	const dialogRef = useDialog<HTMLDivElement>(() => setOpen(false));
	const selected = options.find((option) => option.value === value) ?? null;
	const firstEnabledIndex = options.findIndex((option) => !option.disabled);
	const toneClass = (tone: SelectMenuOption<T>["tone"]) => ({
		brand: "bg-cat-500/14 text-cat-300",
		growth: "bg-growth/14 text-growth",
		info: "bg-info/14 text-info",
		pending: "bg-pending/14 text-pending",
		danger: "bg-danger/14 text-danger",
	}[tone ?? "brand"]);

	function select(option: SelectMenuOption<T>) {
		if (option.disabled) return;
		onChange(option.value);
		setOpen(false);
	}

	function moveOptionFocus(index: number, direction: 1 | -1) {
		let next = index;
		for (let attempts = 0; attempts < options.length; attempts += 1) {
			next = (next + direction + options.length) % options.length;
			if (!options[next]?.disabled) {
				optionRefs.current[next]?.focus();
				return;
			}
		}
	}

	return (
		<div className={className}>
			<span id={titleId} className={showLabel ? "mb-2 block text-[13px] text-text-muted" : "sr-only"}>
				{label}
				{required ? (
					<>
						<span aria-hidden="true"> *</span>
						<span className="sr-only"> ({t("common.required")})</span>
					</>
				) : null}
			</span>
			{name ? <input type="hidden" name={name} value={value ?? ""} /> : null}
			<button
				type="button"
				disabled={disabled}
				aria-haspopup="listbox"
				aria-expanded={open}
				aria-labelledby={`${titleId} ${valueId}`}
				onClick={() => setOpen(true)}
				className={`select-menu-trigger interactive-surface flex items-center justify-between gap-3 border border-border bg-surface text-left disabled:opacity-45 ${compact ? "h-10 min-w-[104px] px-2.5" : "h-12 w-full px-4"}`}
			>
				<span className="flex min-w-0 items-center gap-2.5">
					{selected?.icon ?? (selected?.tone ? <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-[3px] ${toneClass(selected.tone)}`} /> : null)}
					<span id={valueId} className={`truncate ${selected ? "text-text" : "text-text-faint"}`}>{selected?.label ?? placeholder ?? label}</span>
				</span>
				<ChevronIcon />
			</button>

			{open ? createPortal(
				<div className="dialog-backdrop fixed inset-0 z-[70] flex items-end justify-center px-4 animate-fade-in" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }} onClick={() => setOpen(false)}>
					<div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={`${titleId}-sheet`} tabIndex={-1} className="dialog-panel max-h-[78dvh] w-full max-w-[430px] overflow-y-auto overscroll-contain p-4 animate-sheet-up" onClick={(event) => event.stopPropagation()}>
						<div className="sheet-handle mb-3" aria-hidden="true" />
						<div className="mb-3 flex items-center justify-between gap-3 px-1">
							<h2 id={`${titleId}-sheet`} className="font-display text-[20px]">{label}</h2>
							<button type="button" onClick={() => setOpen(false)} aria-label={t("common.close")} className="meli-square-action h-11 w-11">
								<span aria-hidden="true">×</span>
							</button>
						</div>
						<div role="listbox" aria-labelledby={`${titleId}-sheet`} className="flex flex-col gap-1.5">
							{options.map((option, index) => {
								const isSelected = option.value === value;
								return (
									<button
										key={String(option.value)}
										ref={(element) => { optionRefs.current[index] = element; }}
										type="button"
										role="option"
										aria-selected={isSelected}
										disabled={option.disabled}
										data-dialog-initial-focus={isSelected || (!selected && index === firstEnabledIndex) ? "true" : undefined}
										onClick={() => select(option)}
										onKeyDown={(event) => {
											if (event.key === "ArrowDown") { event.preventDefault(); moveOptionFocus(index, 1); }
											if (event.key === "ArrowUp") { event.preventDefault(); moveOptionFocus(index, -1); }
											if (event.key === "Home") { event.preventDefault(); optionRefs.current.find((_, optionIndex) => !options[optionIndex]?.disabled)?.focus(); }
											if (event.key === "End") { event.preventDefault(); [...optionRefs.current].reverse().find((_, reverseIndex) => !options[options.length - 1 - reverseIndex]?.disabled)?.focus(); }
										}}
									className={`select-menu-option flex min-h-14 w-full items-center gap-3 border px-4 py-3 text-left disabled:opacity-40 ${isSelected ? "border-text bg-cat-500/15 shadow-[3px_3px_0_var(--color-cat-700)]" : "border-border bg-surface"}`}
									>
									{option.icon ?? (option.tone ? <span aria-hidden="true" className={`h-9 w-9 shrink-0 rounded-[12px] ${toneClass(option.tone)}`} /> : null)}
										<span className="min-w-0 flex-1">
											<span className="block truncate text-[14px] text-text">{option.label}</span>
											{option.description ? <span className="mt-0.5 block text-[12px] leading-relaxed text-text-muted">{option.description}</span> : null}
										</span>
										{isSelected ? <CheckIcon /> : null}
									</button>
								);
							})}
						</div>
					</div>
				</div>,
				document.body,
			) : null}
		</div>
	);
}

function ChevronIcon() {
	return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-text-faint"><path d="m6 9 6 6 6-6" /></svg>;
}

function CheckIcon() {
	return <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-cat-300"><path d="m5 12 4 4L19 6" /></svg>;
}

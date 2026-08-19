import { forwardRef, type ReactNode } from "react";

function classes(base: string, className?: string) {
	return `${base}${className ? ` ${className}` : ""}`;
}

/** Main financial surface. Pages compose content instead of recreating card geometry. */
export const MoneyPanel = forwardRef<HTMLElement, { children: ReactNode; className?: string }>(
	function MoneyPanel({ children, className }, ref) {
		return (
			<section ref={ref} className={classes("finance-panel", className)}>
				{children}
			</section>
		);
	},
);

/** Quieter nested surface for quotes, fee breakdowns and secondary data. */
export function InsetPanel({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={classes("finance-inset", className)}>{children}</div>;
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<h2 className={classes("finance-section-label", className)}>
			{children}
		</h2>
	);
}

export function SummaryRow({ label, value, valueClassName }: {
	label: ReactNode;
	value: ReactNode;
	valueClassName?: string;
}) {
	return (
		<div className="finance-summary-row">
			<span className="text-text-muted min-w-0">{label}</span>
			<span className={classes("text-text text-right tabular min-w-0 break-words", valueClassName)}>
				{value}
			</span>
		</div>
	);
}

/** Transaction-page footer. It is not navigation and never becomes a bottom bar. */
export function TransactionActions({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
	return (
		<footer className="mt-auto pt-5">
			{children}
			{hint ? <div className="text-[12px] text-text-faint text-center mt-3 leading-relaxed text-pretty">{hint}</div> : null}
		</footer>
	);
}

/** Actions that belong to a card rather than to the page footer. */
export function PanelActions({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
	return (
		<div className="pt-5">
			{children}
			{hint ? <div className="text-[12px] text-text-faint text-center mt-3 leading-relaxed text-pretty">{hint}</div> : null}
		</div>
	);
}

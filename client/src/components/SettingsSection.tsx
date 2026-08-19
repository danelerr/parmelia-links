import type { ReactNode } from "react";
import { Skeleton } from "./Skeleton";

/** Reusable organism for settings groups. It keeps heading, accent, spacing and
 * card semantics identical while each page owns only its domain controls. */
export function SettingsSection({
	title,
	icon,
	tone = "brand",
	id,
	children,
}: {
	title?: string;
	icon?: ReactNode;
	tone?: "brand" | "growth" | "info" | "pending" | "danger" | "neutral";
	id?: string;
	children: ReactNode;
}) {
	const tones = {
		brand: "bg-cat-500/12 text-cat-300",
		growth: "bg-growth/12 text-growth",
		info: "bg-info/12 text-info",
		pending: "bg-pending/12 text-pending",
		danger: "bg-danger/12 text-danger",
		neutral: "bg-surface-3 text-text-muted",
	} as const;
	return (
		<section id={id} className="mb-6 scroll-mt-4">
			{title ? (
				<div className="flex items-center gap-2.5 px-1 mb-2.5">
					{icon ? (
						<span aria-hidden="true" className={`flex h-7 w-7 shrink-0 items-center justify-center ${tones[tone]}`}>
							{icon}
						</span>
					) : null}
					<h2 className="text-text-faint text-[12px] font-semibold uppercase tracking-[0.08em]">
						{title}
					</h2>
				</div>
			) : null}
			<div className="meli-paper-card meli-paper-card--strong overflow-hidden">
				{children}
			</div>
		</section>
	);
}

/** Layout-matching placeholder: users see the final hierarchy immediately,
 * without a spinner or a large layout jump while auxiliary settings load. */
export function SettingsPageSkeleton() {
	return (
		<div aria-hidden="true">
			<div className="mb-7 flex items-center gap-4 border-2 border-text bg-surface p-4 shadow-[5px_5px_0_var(--color-cat-700)]">
				<Skeleton className="skeleton-accent h-14 w-14 shrink-0" />
				<div className="flex-1 flex flex-col gap-2">
					<Skeleton className="h-4 w-32" />
					<Skeleton className="h-3 w-44 max-w-full" />
				</div>
			</div>
			{[104, 88, 144].map((height) => (
				<div key={height} className="mb-6">
					<div className="mb-2.5 flex items-center gap-2 px-1">
						<Skeleton className="h-7 w-7" />
						<Skeleton className="h-3 w-24" />
					</div>
					<div className="meli-paper-card meli-paper-card--strong p-4" style={{ minHeight: height }}>
						<Skeleton className="mb-3 h-3.5 w-[42%]" />
						<Skeleton className="mb-2 h-3 w-[86%]" />
						<Skeleton className="h-3 w-[62%]" />
					</div>
				</div>
			))}
		</div>
	);
}

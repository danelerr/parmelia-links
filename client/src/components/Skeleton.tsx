// Lightweight CSS skeletons (no dependencies) - see `.skeleton` in index.css.
// Meli skeletons preserve the same square geometry as the final surfaces.

import type { CSSProperties } from "react";

export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
	return <div className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}

/** Activity / contact row placeholder: avatar + two text lines + trailing amount.
 *  Mirrors the real row geometry so there's no layout shift when data lands. */
function RowSkeleton({ trailing = true }: { trailing?: boolean }) {
	return (
		<div className="grid min-h-[66px] grid-cols-[40px_1fr_auto] items-center gap-3 border-b border-border px-3 py-3 last:border-b-0">
			<Skeleton className="h-10 w-10 shrink-0" />
			<div className="min-w-0 flex flex-col gap-2">
				<Skeleton className="h-3.5 w-[62%]" />
				<Skeleton className="h-2.5 w-[38%]" />
			</div>
			{trailing ? <Skeleton className="h-7 w-16 shrink-0" /> : <span />}
		</div>
	);
}

/** A short list of row placeholders. */
export function RowSkeletonList({ count = 4, trailing = true }: { count?: number; trailing?: boolean }) {
	return (
		<div className="flex flex-col" aria-hidden="true">
			{Array.from({ length: count }, (_, i) => (
				<RowSkeleton key={i} trailing={trailing} />
			))}
		</div>
	);
}

/** Information/deposit page placeholder: heading copy, QR/content block, CTA. */
export function DetailPageSkeleton({ qr = true }: { qr?: boolean }) {
	return (
		<div className="flex flex-1 flex-col" aria-hidden="true">
			<div className="meli-paper-card meli-paper-card--strong relative mb-5 overflow-hidden p-5">
				<div className="absolute inset-x-0 top-0 h-1 bg-cat-500" />
				<div className="mb-5 flex items-start justify-between gap-4 pt-2">
					<div className="flex-1">
						<Skeleton className="mb-3 h-4 w-36" />
						<Skeleton className="mb-2 h-3 w-[88%]" />
						<Skeleton className="h-3 w-[62%]" />
					</div>
					<Skeleton className="h-12 w-12 shrink-0" />
				</div>
				{qr ? (
					<div className="mx-auto w-fit border-2 border-text bg-paper-2 p-4 shadow-[6px_6px_0_var(--color-cat-700)]">
						<Skeleton className="h-40 w-40 border-0" />
					</div>
				) : (
					<div className="border-2 border-text bg-surface-2 p-4">
						<Skeleton className="mb-3 h-5 w-32" />
						<Skeleton className="h-16 w-full" />
					</div>
				)}
			</div>
			<div className="mb-5 grid grid-cols-[48px_1fr_20px] items-center gap-3 border-2 border-text bg-surface p-3">
				<Skeleton className="h-12 w-12" />
				<div><Skeleton className="mb-2 h-3.5 w-28" /><Skeleton className="h-2.5 w-40 max-w-full" /></div>
				<Skeleton className="h-5 w-5" />
			</div>
			<div className="flex-1" />
			<Skeleton className="skeleton-accent h-12 w-full" />
		</div>
	);
}

/** Transaction/settings form placeholder: choices, detail field, amount and CTA. */
export function FormPageSkeleton() {
	return (
		<div className="flex flex-1 flex-col" aria-hidden="true">
			<Skeleton className="mb-4 h-3 w-24" />
			<div className="mb-6 grid grid-cols-3 gap-1 border-2 border-text bg-surface-2 p-1">
				<Skeleton className="skeleton-accent h-10 border-0" />
				<Skeleton className="h-10 border-0" />
				<Skeleton className="h-10 border-0" />
			</div>
			<div className="meli-paper-card meli-paper-card--strong mb-5 p-5">
				<Skeleton className="mb-3 h-3 w-24" />
				<Skeleton className="h-12 w-full" />
				<Skeleton className="mt-3 h-2.5 w-40 max-w-[70%]" />
			</div>
			<div className="meli-paper-card mb-5 p-5">
				<Skeleton className="mb-5 h-3 w-28" />
				<Skeleton className="skeleton-ink h-12 w-44" />
				<div className="mt-5 flex justify-between gap-4 border-t border-border pt-4">
					<Skeleton className="h-3 w-20" />
					<Skeleton className="h-3 w-24" />
				</div>
			</div>
			<div className="flex-1" />
			<Skeleton className="skeleton-accent h-12 w-full" />
		</div>
	);
}

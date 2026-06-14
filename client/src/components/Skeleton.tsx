// Lightweight CSS skeletons (no dependencies) - see `.skeleton` in index.css.
// Pass the radius via a utility class so it can match each element it stands in
// for (rounded-full avatars, rounded text lines).

import type { CSSProperties } from "react";

export function Skeleton({ className = "", style }: { className?: string; style?: CSSProperties }) {
	return <div className={`skeleton ${className}`} style={style} aria-hidden="true" />;
}

/** Activity / contact row placeholder: avatar + two text lines + trailing amount.
 *  Mirrors the real row geometry so there's no layout shift when data lands. */
export function RowSkeleton({ trailing = true }: { trailing?: boolean }) {
	return (
		<div className="flex items-center gap-3.5 py-3 px-2">
			<Skeleton className="w-10 h-10 rounded-full shrink-0" />
			<div className="flex-1 min-w-0 flex flex-col gap-2">
				<Skeleton className="h-3.5 w-[55%] rounded-[6px]" />
				<Skeleton className="h-3 w-[30%] rounded-[6px]" />
			</div>
			{trailing && <Skeleton className="h-3.5 w-14 rounded-[6px] shrink-0" />}
		</div>
	);
}

/** A short list of row placeholders. */
export function RowSkeletonList({ count = 4, trailing = true }: { count?: number; trailing?: boolean }) {
	return (
		<div className="flex flex-col gap-1" aria-hidden="true">
			{Array.from({ length: count }, (_, i) => (
				<RowSkeleton key={i} trailing={trailing} />
			))}
		</div>
	);
}

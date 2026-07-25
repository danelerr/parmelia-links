// Shared icon set: every inline SVG that appears on 2+ screens lives here so a
// stroke or size tweak happens exactly once. Icons inherit currentColor unless
// the call site passes an explicit stroke.

export function IconBack({ size = 20 }: { size?: number }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			<path d="M19 12H5" />
			<path d="M12 19l-7-7 7-7" />
		</svg>
	);
}

export function IconCheck({ size = 32, stroke = "#9ce3f4" }: { size?: number; stroke?: string }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
			<polyline points="20 6 9 17 4 12" />
		</svg>
	);
}

export function IconCross({ size = 30, stroke = "#f4a9cf" }: { size?: number; stroke?: string }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</svg>
	);
}

export function IconArrowRight({ size = 32, stroke = "#9ce3f4" }: { size?: number; stroke?: string }) {
	return (
		<svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={stroke} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
			<path d="M5 12h14" />
			<path d="m12 5 7 7-7 7" />
		</svg>
	);
}

/** Brand spinner. Size via className (defaults to the 24px inline variant). */
export function Spinner({ className = "w-6 h-6" }: { className?: string }) {
	return <div className={`border-2 border-surface-2 border-t-sky rounded-full animate-spin ${className}`} />;
}

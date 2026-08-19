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

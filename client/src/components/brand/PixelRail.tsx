export default function PixelRail({
	className = "",
	state = "idle",
}: {
	className?: string;
	state?: "idle" | "active" | "done" | "future";
}) {
	return (
		<span className={`pixel-rail pixel-rail-${state}${className ? ` ${className}` : ""}`} aria-hidden="true">
			<span />
		</span>
	);
}

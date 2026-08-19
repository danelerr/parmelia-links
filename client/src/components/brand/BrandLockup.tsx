import CatGlyph from "./CatGlyph";

export default function BrandLockup({
	className = "",
	compact = false,
}: {
	className?: string;
	compact?: boolean;
}) {
	return (
		<span className={`brand-lockup${className ? ` ${className}` : ""}`}>
			<CatGlyph className={compact ? "w-7" : "w-9"} />
			<span className={compact ? "text-[15px]" : "text-[19px]"}>GatoPago</span>
		</span>
	);
}

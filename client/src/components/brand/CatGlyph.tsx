import MeliSprite from "./MeliSprite";

export default function CatGlyph({
	className = "w-9",
	label,
}: {
	className?: string;
	label?: string;
}) {
	return (
		<span className={`cat-glyph ${className}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
			<MeliSprite name="head-neutral" className="h-full w-full" priority />
		</span>
	);
}

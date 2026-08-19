import CatGlyph from "./brand/CatGlyph";

/** Stable compatibility wrapper for existing product-surface imports. */
export default function Logo({ className = "w-10" }: { className?: string }) {
	return <CatGlyph className={className} />;
}

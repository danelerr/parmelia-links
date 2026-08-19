// The one operation-result block (R-5 in UX_DESIGN.md): success, in-flight or
// failed, centered in the page body. Pages pass localized copy; `state` only
// drives the icon and default emphasis. Extra content (explorer links, live
// status, buttons) goes in children.

import type { ReactNode } from "react";
import MeliSprite from "./brand/MeliSprite";
import PixelRail from "./brand/PixelRail";

export type TxResultState = "success" | "pending" | "failed" | "progress";

export default function TxResult({
	state,
	lead,
	amount,
	unit,
	body,
	bodyClassName,
	children,
}: {
	state: TxResultState;
	lead: string;
	/** Pre-formatted amount (page owns decimals/locale). */
	amount?: string;
	unit?: string;
	body?: string;
	/** Overrides the default body styling (e.g. live tracking lines). */
	bodyClassName?: string;
	children?: ReactNode;
}) {
	return (
		<div className="flex-1 flex flex-col items-center justify-center text-center" role="status" aria-live="polite">
			<MeliSprite
				name={state === "success" ? "head-happy" : state === "failed" ? "head-cautious" : "head-focused"}
				motion={state === "success" ? "purr" : "none"}
				className="mb-5 w-24"
			/>
			{state === "pending" || state === "progress" ? <PixelRail state="active" className="mb-4 max-w-[180px]" /> : null}
			{state === "success" ? <span className="mb-4 flex h-10 w-10 items-center justify-center border-2 border-growth bg-growth/12 text-growth shadow-[3px_3px_0_rgb(40_123_85/.24)]" aria-hidden="true">✓</span> : null}
			<p className="text-[15px] text-text-muted mb-1 text-pretty">{lead}</p>
			{amount !== undefined && (
				<p className="type-mono mb-4 max-w-full break-words text-[40px] font-bold leading-none">
					{amount}
					{unit && <span className="text-text-muted text-[20px] ml-1.5">{unit}</span>}
				</p>
			)}
			{body !== undefined && (
				<p
					className={
						bodyClassName ??
						"text-[13px] text-text-faint mb-2 max-w-[320px] leading-relaxed text-pretty"
					}
				>
					{body}
				</p>
			)}
			{children}
		</div>
	);
}

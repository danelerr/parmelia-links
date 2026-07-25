// The one operation-result block (R-5 in UX_DESIGN.md): success, in-flight or
// failed, centered in the page body. Pages pass localized copy; `state` only
// drives the icon and default emphasis. Extra content (explorer links, live
// status, buttons) goes in children.

import type { ReactNode } from "react";
import { IconArrowRight, IconCheck, IconCross, Spinner } from "./icons";

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
		<div className="flex-1 flex flex-col items-center justify-center text-center">
			{state === "failed" ? (
				<div className="w-16 h-16 rounded-full bg-pink/15 flex items-center justify-center mb-6">
					<IconCross />
				</div>
			) : (
				<div className="w-16 h-16 rounded-full bg-sky/15 flex items-center justify-center mb-6 shadow-glow-sky">
					{state === "success" ? (
						<IconCheck />
					) : state === "progress" ? (
						<IconArrowRight />
					) : (
						<Spinner className="w-7 h-7" />
					)}
				</div>
			)}
			<p className="text-[15px] text-text-muted mb-1">{lead}</p>
			{amount !== undefined && (
				<p className="font-display text-[40px] leading-none tabular mb-4 max-w-full break-words">
					{amount}
					{unit && <span className="text-text-muted text-[20px] ml-1.5">{unit}</span>}
				</p>
			)}
			{body !== undefined && (
				<p
					role="status"
					aria-live="polite"
					className={
						bodyClassName ??
						`text-[13px] text-text-faint mb-2${state === "pending" ? " animate-pulse-soft" : ""}`
					}
				>
					{body}
				</p>
			)}
			{children}
		</div>
	);
}

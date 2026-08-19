import { useTranslation } from "react-i18next";

type StepState = "waiting" | "active" | "done" | "error";

function Step({
	state,
	title,
	detail,
	last = false,
}: {
	state: StepState;
	title: string;
	detail: string;
	last?: boolean;
}) {
	return (
		<li className="relative flex gap-3.5 min-h-16">
			{!last ? (
				<span
					aria-hidden="true"
					className={`absolute left-[11px] top-6 bottom-0 w-1 ${state === "done" ? "bg-growth/55" : "bg-border"}`}
				/>
			) : null}
			<span
				aria-hidden="true"
				className={`relative z-1 mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center border ${
					state === "done"
						? "border-growth bg-growth/20 text-growth"
						: state === "active"
							? "border-cat-500/50 bg-cat-500/15 text-cat-300"
							: state === "error"
								? "border-danger bg-danger/15 text-danger"
								: "bg-surface-2 border-border text-text-faint"
				}`}
			>
				{state === "done" ? (
					<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
						<polyline points="20 6 9 17 4 12" />
					</svg>
				) : state === "error" ? (
					<span className="text-[13px] leading-none">!</span>
				) : (
					<span className={`h-1.5 w-1.5 rounded-[2px] ${state === "active" ? "bg-cat-500" : "bg-text-faint"}`} />
				)}
			</span>
			<div className="pb-5 min-w-0">
				<p className={`text-[14px] ${state === "waiting" ? "text-text-faint" : "text-text"}`}>{title}</p>
				<p className="text-[12px] text-text-muted leading-relaxed mt-0.5">{detail}</p>
			</div>
		</li>
	);
}

export default function CrosschainTimeline({
	status,
	destinationName,
	delayed,
}: {
	status: string | null;
	destinationName: string;
	delayed: boolean;
}) {
	const { t } = useTranslation();
	const failed = status === "failed" || status === "expired" || status === "needs_support";
	const sourceDone = Boolean(status && !["quoted", "pending_signature", "submitted"].includes(status));
	const attestationDone = Boolean(status && ["minting", "recoverable", "completed"].includes(status));
	const arrived = status === "completed";

	const sourceState: StepState = failed ? "error" : sourceDone ? "done" : "active";
	const attestationState: StepState = failed
		? "error"
		: attestationDone
			? "done"
			: sourceDone
				? "active"
				: "waiting";
	const deliveryState: StepState = failed
		? "error"
		: arrived
			? "done"
			: attestationDone
				? "active"
				: "waiting";

	return (
		<ol className="meli-paper-card meli-paper-card--strong w-full px-5 pb-1 pt-5 text-left" aria-live="polite">
			<Step
				state={sourceState}
				title={t("crosschain.timelineSource")}
				detail={sourceDone ? t("crosschain.timelineSourceDone") : t("crosschain.timelineSourceWait")}
			/>
			<Step
				state={attestationState}
				title={t("crosschain.timelineAttestation")}
				detail={attestationDone ? t("crosschain.timelineAttestationDone") : t("crosschain.timelineAttestationWait")}
			/>
			<Step
				last
				state={deliveryState}
				title={t("crosschain.timelineDestination", { network: destinationName })}
				detail={
					failed
						? t("crosschain.timelineNeedsHelp")
						: arrived
							? t("crosschain.timelineDestinationDone")
							: status === "recoverable"
								? t("crosschain.timelineRetrying")
								: delayed
									? t("crosschain.timelineDelayed")
									: t("crosschain.timelineDestinationWait")
				}
			/>
		</ol>
	);
}

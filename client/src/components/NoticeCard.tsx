import type { ReactNode } from "react";

export default function NoticeCard({
	tone = "info",
	title,
	children,
	className = "",
}: {
	tone?: "info" | "warning" | "danger" | "success";
	title: string;
	children?: ReactNode;
	className?: string;
}) {
	const styles = {
		info: "border-info bg-info/8 text-info",
		warning: "border-pending bg-pending/8 text-pending",
		danger: "border-danger bg-danger/8 text-danger",
		success: "border-growth bg-growth/8 text-growth",
	} as const;
	return (
		<div className={`flex items-start gap-3 border-l-4 border-y border-r px-4 py-3.5 ${styles[tone]} ${className}`}>
			<span className="flex h-6 w-6 shrink-0 items-center justify-center border border-current bg-current/10" aria-hidden="true">
				{tone === "warning" || tone === "danger" ? (
					<span className="text-[13px] font-semibold">!</span>
				) : tone === "success" ? (
					<span className="text-[13px] font-semibold">✓</span>
				) : (
					<span className="text-[13px] font-semibold">i</span>
				)}
			</span>
			<div className="min-w-0">
				<p className="text-[12px] font-semibold">{title}</p>
				{children ? <div className="text-[12px] text-text-muted leading-relaxed mt-0.5">{children}</div> : null}
			</div>
		</div>
	);
}

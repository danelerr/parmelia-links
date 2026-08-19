// Tappable option row used in the "Otras opciones" sections of Cobrar (money-in
// methods) and Pagar (money-out methods). GatoPago card style: tonal surface,
// brand-accent icon disc, optional "coming soon" badge / disabled state.
// Pass `to` for pure navigation (renders a real link); `onClick` for actions.

import type { ReactNode } from "react";
import LinkButton from "./LinkButton";

type OptionCardProps = {
	title: string;
	desc: string;
	tone?: "brand" | "growth" | "info" | "pending" | "danger" | "neutral";
	icon: ReactNode;
	/** Route target - preferred when the tap only navigates. */
	to?: string;
	onClick?: () => void;
	badge?: string;
	disabled?: boolean;
};

const BASE_CLASS =
	"meli-path-card-app interactive-surface w-full p-4 text-left";

const TONES = {
	brand: "bg-cat-500/12 text-cat-300",
	growth: "bg-growth/12 text-growth",
	info: "bg-info/12 text-info",
	pending: "bg-pending/12 text-pending",
	danger: "bg-danger/12 text-danger",
	neutral: "bg-surface-3 text-text-muted",
} as const;

export default function OptionCard({ title, desc, tone = "brand", icon, to, onClick, badge, disabled }: OptionCardProps) {
	const content = (
		<>
			<span
				aria-hidden="true"
				className={`flex h-11 w-11 shrink-0 items-center justify-center ${TONES[tone]}`}
			>
				{icon}
			</span>
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					<p className="text-[14px] text-text">{title}</p>
					{badge && (
						<span className="meli-chip border-border bg-surface-2 text-text-faint">
							{badge}
						</span>
					)}
				</div>
				<p className="text-[12px] text-text-muted leading-relaxed line-clamp-2">{desc}</p>
			</div>
			{!disabled && (
				<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-faint shrink-0">
					<path d="m9 18 6-6-6-6" />
				</svg>
			)}
		</>
	);

	if (to && !disabled) {
		return (
			<LinkButton to={to} className={BASE_CLASS}>
				{content}
			</LinkButton>
		);
	}

	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={`${BASE_CLASS} disabled:cursor-default disabled:opacity-55`}
		>
			{content}
		</button>
	);
}

// Tappable option row used in the "Otras opciones" sections of Cobrar (money-in
// methods) and Pagar (money-out methods). Parmelia card style: surface + border,
// brand-accent icon disc, optional "coming soon" badge / disabled state.
// Pass `to` for pure navigation (renders a real link); `onClick` for actions.

import type { ReactNode } from "react";
import LinkButton from "./LinkButton";

type OptionCardProps = {
	title: string;
	desc: string;
	/** Brand accent hex (e.g. "#9ce3f4" sky, "#f4a9cf" pink, "#efe08c" gold). */
	accent: string;
	icon: ReactNode;
	/** Route target - preferred when the tap only navigates. */
	to?: string;
	onClick?: () => void;
	badge?: string;
	disabled?: boolean;
};

const BASE_CLASS =
	"w-full flex items-center gap-3.5 bg-surface border border-border rounded-[16px] p-4 text-left transition-colors";

export default function OptionCard({ title, desc, accent, icon, to, onClick, badge, disabled }: OptionCardProps) {
	const content = (
		<>
			<span
				className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
				style={{ background: `${accent}26`, color: accent }}
			>
				{icon}
			</span>
			<div className="flex-1 min-w-0">
				<div className="flex items-center gap-2">
					<p className="text-[14px] text-text">{title}</p>
					{badge && (
						<span className="text-[10px] uppercase tracking-wide text-text-faint border border-border rounded-full px-2 py-0.5">
							{badge}
						</span>
					)}
				</div>
				<p className="text-[12px] text-text-muted truncate">{desc}</p>
			</div>
			{!disabled && (
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-faint shrink-0">
					<path d="m9 18 6-6-6-6" />
				</svg>
			)}
		</>
	);

	if (to && !disabled) {
		// `:enabled` doesn't match anchors, so the hover state is applied directly.
		return (
			<LinkButton to={to} className={`${BASE_CLASS} hover:border-border-strong`}>
				{content}
			</LinkButton>
		);
	}

	return (
		<button
			onClick={onClick}
			disabled={disabled}
			className={`${BASE_CLASS} enabled:hover:border-border-strong disabled:opacity-55 disabled:cursor-default`}
		>
			{content}
		</button>
	);
}

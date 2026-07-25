// Horizontal scrollable chain-selector chips, shared by every screen that
// picks a network.

export default function NetworkChips({
	options,
	selected,
	onSelect,
}: {
	options: { id: number; label: string }[];
	selected: number | null;
	onSelect: (id: number) => void;
}) {
	return (
		<div className="flex gap-1.5 mb-5 overflow-x-auto -mx-1 px-1 pb-1">
			{options.map((o) => (
				<button
					key={o.id}
					onClick={() => onSelect(o.id)}
					aria-pressed={selected === o.id}
					className={`shrink-0 px-4 h-10 rounded-full text-[13px] border transition-colors flex items-center gap-1.5 ${
						selected === o.id
							? "bg-sky/25 text-glow-sky border-sky font-semibold"
							: "text-text-muted border-border hover:text-text font-medium"
					}`}
				>
					{selected === o.id && (
						<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
							<polyline points="20 6 9 17 4 12" />
						</svg>
					)}
					{o.label}
				</button>
			))}
		</div>
	);
}

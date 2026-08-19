import { formatAmount } from "../lib/format";
import { formatShortDate, transactionPresentation, type Transaction } from "../lib/transactions";

export default function ActivityRow({ tx, hideAmount = false, onOpen }: {
	tx: Transaction;
	hideAmount?: boolean;
	onOpen: () => void;
}) {
	const received = tx.type === "received";
	const swapped = tx.kind === "swap";
	const presentation = transactionPresentation(tx);
	return (
		<button
			type="button"
			onClick={onOpen}
			className="interactive-surface flex w-full items-center gap-3.5 border-b border-border bg-surface px-3 py-3 text-left last:border-b-0 hover:bg-cat-50"
			aria-label={`${presentation.title}, ${presentation.detail}, ${tx.amount} ${tx.currency}`}
		>
			<span aria-hidden="true" className={`flex h-10 w-10 shrink-0 items-center justify-center border border-current ${tx.kind === "earn" ? "bg-growth/12 text-growth" : swapped ? "bg-info/12 text-info" : received ? "bg-growth/12 text-growth" : "bg-cat-500/12 text-cat-300"}`}>
				{tx.kind === "earn" ? <GrowIcon /> : swapped ? <SwapIcon /> : received ? <ReceiveIcon /> : <SendIcon />}
			</span>
			<span className="min-w-0 flex-1">
				<span className="block truncate text-[15px]">{presentation.title}</span>
				<span className="block truncate text-[12px] text-text-muted">{presentation.detail}</span>
				<span className="block text-[11px] text-text-faint">{presentation.status} · {formatShortDate(tx.createdAt)}</span>
			</span>
			<span className={`type-mono shrink-0 text-right text-[14px] font-semibold ${hideAmount ? "text-text-faint" : received ? "text-growth" : "text-text"}`}>
				{hideAmount ? "••••" : `${received ? "+" : "−"}${formatAmount(tx.amount, tx.currency)}`}
				<span className="block text-[10px] font-normal text-text-faint">{tx.currency}</span>
			</span>
		</button>
	);
}

function ReceiveIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></svg>; }
function SendIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>; }
function GrowIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 18 10 12l4 4 6-8" /><path d="M16 8h4v4" /></svg>; }
function SwapIcon() { return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 7h11l-3-3" /><path d="m18 7-3 3" /><path d="M17 17H6l3 3" /><path d="m6 17 3-3" /></svg>; }

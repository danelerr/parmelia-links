// Full statement: every movement with quick ranges, custom date range, asset
// and type filters. Home only keeps the compact "Actividad reciente".

import { useMemo, useState } from "react";
import useSWR from "swr";
import type { User } from "../lib/firebase";
import { SERVER_URL } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import Logo from "../components/Logo";
import ReceiptModal from "../components/ReceiptModal";
import { RowSkeletonList } from "../components/Skeleton";
import { activeNetwork } from "../lib/activeNetwork";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { parseTransactions, formatShortDate, txLabel, type Transaction } from "../lib/transactions";


type PeriodOption = "all" | "week" | "month" | "prev-month" | "custom";
type TypeFilter = "all" | "sent" | "received";

const PERIOD_OPTIONS: [PeriodOption, string][] = [
	["all", "Todas las fechas"],
	["week", "Última semana"],
	["month", "Este mes"],
	["prev-month", "Mes anterior"],
	["custom", "Rango personalizado"],
];

function periodBounds(period: PeriodOption): { start: Date | null; end: Date | null } {
	const now = new Date();
	if (period === "week") {
		const start = new Date(now);
		start.setDate(now.getDate() - 7);
		return { start, end: null };
	}
	if (period === "month") {
		return { start: new Date(now.getFullYear(), now.getMonth(), 1), end: null };
	}
	if (period === "prev-month") {
		return {
			start: new Date(now.getFullYear(), now.getMonth() - 1, 1),
			// Day 0 of the current month = last day of the previous one.
			end: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999),
		};
	}
	return { start: null, end: null };
}

export default function Statement({ user }: { user: User }) {
	const navigate = useViewTransitionNavigate();
	const [period, setPeriod] = useState<PeriodOption>("all");
	const [fromDate, setFromDate] = useState("");
	const [toDate, setToDate] = useState("");
	const [asset, setAsset] = useState("all");
	const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
	const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);

	const fetcher = async (url: string) => {
		const res = await fetchWithAuth(user, url);
		if (!res.ok) throw new Error("API error");
		return res.json();
	};

	const { data: txData, isLoading } = useSWR(`${SERVER_URL}/user/transactions`, fetcher, {
		revalidateOnFocus: true,
	});

	const transactions = useMemo(() => parseTransactions(txData), [txData]);

	const filtered = useMemo(() => {
		let start: Date | null = null;
		let end: Date | null = null;
		if (period === "custom") {
			if (fromDate) start = new Date(`${fromDate}T00:00:00`);
			if (toDate) end = new Date(`${toDate}T23:59:59`);
		} else {
			({ start, end } = periodBounds(period));
		}

		return transactions.filter((t) => {
			const when = new Date(t.createdAt).getTime();
			if (start && when < start.getTime()) return false;
			if (end && when > end.getTime()) return false;
			if (asset !== "all" && t.currency !== asset) return false;
			if (typeFilter === "sent" && t.type !== "sent") return false;
			if (typeFilter === "received" && t.type !== "received") return false;
			return true;
		});
	}, [transactions, period, fromDate, toDate, asset, typeFilter]);

	return (
		<div className="flex flex-col min-h-dvh px-5 pt-[calc(env(safe-area-inset-top)_+_1.5rem)] pb-[calc(env(safe-area-inset-bottom)_+_3rem)] w-full max-w-[460px] mx-auto animate-fade-up">
			<header className="flex items-center gap-3 mb-6">
				<button
					onClick={() => navigate("/")}
					aria-label="Volver"
					className="w-10 h-10 -ml-1 rounded-full flex items-center justify-center text-text-muted hover:text-text hover:bg-surface transition-colors"
				>
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<path d="M19 12H5" />
						<path d="M12 19l-7-7 7-7" />
					</svg>
				</button>
				<h1 className="text-[22px]">Extracto</h1>
			</header>

			{/* Period dropdown */}
			<div className="relative mb-3">
				<select
					value={period}
					onChange={(e) => setPeriod(e.target.value as PeriodOption)}
					className="w-full h-12 appearance-none bg-surface border border-border rounded-[14px] pl-4 pr-10 text-[14px] text-text [color-scheme:dark] focus:border-border-strong transition-colors"
				>
					{PERIOD_OPTIONS.map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
				<svg
					width="16"
					height="16"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-text-faint"
				>
					<path d="m6 9 6 6 6-6" />
				</svg>
			</div>

			{/* Custom range */}
			{period === "custom" && (
				<div className="flex gap-2.5 mb-3">
					{(
						[
							["Desde", fromDate, setFromDate],
							["Hasta", toDate, setToDate],
						] as const
					).map(([label, value, set]) => (
						<label key={label} className="flex-1 bg-surface border border-border rounded-[14px] px-3.5 py-2.5">
							<span className="block text-[11px] text-text-faint mb-0.5">{label}</span>
							<input
								type="date"
								value={value}
								onChange={(e) => set(e.target.value)}
								className="w-full bg-transparent text-[13px] text-text [color-scheme:dark]"
							/>
						</label>
					))}
				</div>
			)}

			{/* Asset + type filters */}
			<div className="seg-track seg-track-block mb-2">
				{["all", ...activeNetwork.currencies].map((c) => (
					<button
						key={c}
						onClick={() => setAsset(c)}
						data-active={asset === c}
						className="seg-item"
					>
						{c === "all" ? "Todas" : c}
					</button>
				))}
			</div>
			<div className="seg-track seg-track-block mb-5">
				{(
					[
						["all", "Todos"],
						["sent", "Enviados"],
						["received", "Recibidos"],
					] as const
				).map(([value, label]) => (
					<button
						key={value}
						onClick={() => setTypeFilter(value)}
						data-active={typeFilter === value}
						className="seg-item"
					>
						{label}
					</button>
				))}
			</div>

			{/* List */}
			{isLoading && !txData ? (
				<RowSkeletonList count={8} />
			) : filtered.length === 0 ? (
				<div className="flex flex-col items-center text-center py-14 px-6">
					<Logo className="w-10 mb-4 opacity-40" />
					<p className="text-[14px] text-text-muted">No hay movimientos con estos filtros.</p>
				</div>
			) : (
				<>
					<p className="text-[12px] text-text-faint px-1 mb-2">
						{filtered.length} movimiento{filtered.length === 1 ? "" : "s"}
					</p>
					<div className="flex flex-col gap-1">
						{filtered.map((tx) => {
							const received = tx.type === "received";
							return (
								<button
									key={tx.txHash + tx.type}
									onClick={() => setSelectedTx(tx)}
									className="flex items-center gap-3.5 py-3 px-2 -mx-2 rounded-[14px] hover:bg-surface transition-colors text-left"
								>
									<span
										className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
											received ? "bg-sky/15 text-glow-sky" : "bg-pink/15 text-glow-pink"
										}`}
									>
										<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
											{received ? (
												<>
													<path d="M12 5v14" />
													<path d="m19 12-7 7-7-7" />
												</>
											) : (
												<>
													<path d="M12 19V5" />
													<path d="m5 12 7-7 7 7" />
												</>
											)}
										</svg>
									</span>
									<div className="min-w-0 flex-1">
										<p className="text-[15px] truncate">{txLabel(tx)}</p>
										<p className="text-[12px] text-text-faint">
											{formatShortDate(tx.createdAt)}
											{tx.kind === "link" && " · Link de cobro"}
										</p>
									</div>
									<span
										className={`text-[15px] font-medium tabular shrink-0 ${
											received ? "text-glow-sky" : "text-glow-pink"
										}`}
									>
										{received ? "+" : "−"}
										{tx.amount} {tx.currency}
									</span>
								</button>
							);
						})}
					</div>
				</>
			)}

			{selectedTx && <ReceiptModal tx={selectedTx} onClose={() => setSelectedTx(null)} />}
		</div>
	);
}

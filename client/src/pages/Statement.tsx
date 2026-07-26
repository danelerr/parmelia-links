// Full statement: every movement with quick ranges, custom date range, asset
// and type filters. Home only keeps the compact "Actividad reciente".
// Filters live in the URL (useSearchParams): a filtered view can be shared and
// back/forward walks through filter changes; defaults keep the URL clean.

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import useSWRInfinite from "swr/infinite";
import type { User } from "../lib/firebase";
import { SERVER_URL } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import Logo from "../components/Logo";
import BackHeader from "../components/BackHeader";
import ReceiptModal from "../components/ReceiptModal";
import { RowSkeletonList } from "../components/Skeleton";
import { activeNetwork } from "../lib/activeNetwork";
import {
	parseTransactions,
	formatShortDate,
	txLabel,
	type RawTxPayload,
	type Transaction,
} from "../lib/transactions";
import { formatAmount } from "../lib/format";


type PeriodOption = "all" | "today" | "week" | "month" | "prev-month" | "custom";
type TypeFilter = "all" | "sent" | "received";

// Label is an i18n key, resolved with t() at render time.
const PERIOD_OPTIONS: [PeriodOption, string][] = [
	["all", "statement.allDates"],
	["today", "statement.today"],
	["week", "statement.lastWeek"],
	["month", "statement.thisMonth"],
	["prev-month", "statement.prevMonth"],
	["custom", "statement.customRange"],
];

function periodBounds(period: PeriodOption): { start: Date | null; end: Date | null } {
	const now = new Date();
	if (period === "today") {
		return { start: new Date(now.getFullYear(), now.getMonth(), now.getDate()), end: null };
	}
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
	const { t } = useTranslation();
	const [searchParams, setSearchParams] = useSearchParams();
	const [selectedTx, setSelectedTx] = useState<Transaction | null>(null);
	// Same privacy mode as Home: amounts stay masked while "hide balance" is on.
	const hideBalance = localStorage.getItem("parmelia:hideBalance") === "1";

	// Filters come FROM the URL (validated; anything unknown falls back to the
	// default so a mangled shared link still renders).
	const periodParam = searchParams.get("period");
	const period: PeriodOption = PERIOD_OPTIONS.some(([value]) => value === periodParam)
		? (periodParam as PeriodOption)
		: "all";
	const fromDate = searchParams.get("from") ?? "";
	const toDate = searchParams.get("to") ?? "";
	const assetParam = searchParams.get("asset");
	const asset = assetParam && activeNetwork.currencies.includes(assetParam) ? assetParam : "all";
	const typeParam = searchParams.get("type");
	const typeFilter: TypeFilter =
		typeParam === "sent" || typeParam === "received" ? typeParam : "all";

	// Write filters TO the URL. Defaults ("all" / empty) are removed so the
	// default view keeps a clean /statement URL.
	function setFilter(patch: Partial<Record<"period" | "from" | "to" | "asset" | "type", string>>) {
		const next = new URLSearchParams(searchParams);
		for (const [key, value] of Object.entries(patch)) {
			if (!value || value === "all") next.delete(key);
			else next.set(key, value);
		}
		setSearchParams(next);
	}

	const fetcher = async (url: string): Promise<RawTxPayload> => {
		const res = await fetchWithAuth(user, url);
		if (!res.ok) throw new Error("API error");
		return res.json();
	};

	const { data: pages, isLoading, isValidating, size, setSize } =
		useSWRInfinite<RawTxPayload>(
			(_pageIndex, previousPage) => {
				if (previousPage && !previousPage.nextCursor) return null;
				const query = new URLSearchParams({ limit: "50" });
				if (previousPage?.nextCursor) {
					query.set("before", previousPage.nextCursor);
				}
				return `${SERVER_URL}/user/transactions?${query.toString()}`;
			},
			fetcher,
			{
				revalidateOnFocus: true,
				revalidateFirstPage: true,
			},
		);
	const txData = useMemo<RawTxPayload | undefined>(() => {
		if (!pages) return undefined;
		return {
			sent: pages.flatMap((page) => page.sent ?? []),
			received: pages.flatMap((page) => page.received ?? []),
		};
	}, [pages]);
	const hasMore = Boolean(pages?.at(-1)?.nextCursor);
	const isLoadingMore =
		isValidating && Boolean(pages) && pages!.length < size;

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
			<BackHeader to="/" title={t("statement.title")} className="mb-6" />

			{/* Period dropdown */}
			<div className="relative mb-3">
				<select
					value={period}
					aria-label={t("statement.periodLabel")}
					onChange={(e) => {
						const value = e.target.value as PeriodOption;
						// Leaving "custom" drops the stale date range from the URL.
						setFilter({ period: value, ...(value !== "custom" ? { from: "", to: "" } : {}) });
					}}
					className="w-full h-12 appearance-none bg-surface border border-border rounded-[14px] pl-4 pr-10 text-[14px] text-text [color-scheme:dark] focus:border-border-strong transition-colors"
				>
					{PERIOD_OPTIONS.map(([value, label]) => (
						<option key={value} value={value}>
							{t(label)}
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
							["statement.from", "from", fromDate],
							["statement.to", "to", toDate],
						] as const
					).map(([label, param, value]) => (
						<label key={label} className="flex-1 bg-surface border border-border rounded-[14px] px-3.5 py-2.5">
							<span className="block text-[11px] text-text-faint mb-0.5">{t(label)}</span>
							<input
								type="date"
								name={param}
								value={value}
								onChange={(e) => setFilter({ [param]: e.target.value })}
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
						onClick={() => setFilter({ asset: c })}
						aria-pressed={asset === c}
						data-active={asset === c}
						className="seg-item"
					>
						{c === "all" ? t("statement.all") : c}
					</button>
				))}
			</div>
			<div className="flex justify-center mb-5">
				<div className="seg-track">
					{(
						[
							["all", "statement.allTypes", null],
							["received", "statement.received", "in"],
							["sent", "statement.sent", "out"],
						] as const
					).map(([value, label, dir]) => (
						<button
							key={value}
							onClick={() => setFilter({ type: value })}
							aria-pressed={typeFilter === value}
							data-active={typeFilter === value}
							className="seg-item gap-1.5"
						>
							{dir && (
								<svg
									width="13"
									height="13"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.5"
									strokeLinecap="round"
									strokeLinejoin="round"
									className={dir === "in" ? "text-glow-sky" : "text-glow-pink"}
								>
									{dir === "in" ? (
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
							)}
							{t(label)}
						</button>
					))}
				</div>
			</div>

			{/* List */}
			{isLoading && !txData ? (
				<RowSkeletonList count={8} />
			) : filtered.length === 0 ? (
				<div className="flex flex-col items-center text-center py-14 px-6">
					<Logo className="w-10 mb-4 opacity-40" />
					<p className="text-[14px] text-text-muted">{t("statement.noMovements")}</p>
				</div>
			) : (
				<>
					<p className="text-[12px] text-text-faint px-1 mb-2">
						{t("statement.movement", { count: filtered.length })}
					</p>
					<div className="flex flex-col gap-1">
						{filtered.map((tx) => {
							const received = tx.type === "received";
							return (
								<button
									key={tx.id}
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
											{tx.kind === "link" && ` · ${t("statement.fromLink")}`}
										</p>
									</div>
									<span
										className={`text-[15px] font-medium tabular shrink-0 ${
											hideBalance ? "text-text-faint" : received ? "text-glow-sky" : "text-glow-pink"
										}`}
									>
										{!hideBalance && (received ? "+" : "−")}
										{hideBalance ? "••••" : `${formatAmount(tx.amount, tx.currency)} ${tx.currency}`}
									</span>
								</button>
							);
						})}
					</div>
				</>
			)}
			{hasMore && (
				<button
					type="button"
					disabled={isLoadingMore}
					onClick={() => void setSize((current) => current + 1)}
					className="mt-5 h-11 rounded-[14px] border border-border bg-surface text-[14px] text-text-muted hover:text-text disabled:opacity-50 transition-colors"
				>
					{isLoadingMore
						? t("statement.loadingMore")
						: t("statement.loadMore")}
				</button>
			)}

			{selectedTx && <ReceiptModal tx={selectedTx} onClose={() => setSelectedTx(null)} />}
		</div>
	);
}

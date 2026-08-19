// Full statement: every movement with quick ranges, custom date range, asset
// and type filters. Home only keeps the compact "Actividad reciente".
// Filters live in the URL (useSearchParams): a filtered view can be shared and
// back/forward walks through filter changes; defaults keep the URL clean.

import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import useSWRInfinite from "swr/infinite";
import type { User } from "../lib/firebase";
import { SERVER_URL } from "../lib/api";
import { fetchWithAuth } from "../lib/authFetch";
import Logo from "../components/Logo";
import ReceiptModal from "../components/ReceiptModal";
import ActivityRow from "../components/ActivityRow";
import PrimaryNav from "../components/PrimaryNav";
import Screen from "../components/Screen";
import { RowSkeletonList } from "../components/Skeleton";
import SelectMenu from "../components/SelectMenu";
import { activeNetwork } from "../lib/activeNetwork";
import { readMigratedStorage } from "../lib/storageMigration";
import {
	parseTransactions,
	type RawTxPayload,
	type Transaction,
} from "../lib/transactions";


type PeriodOption = "all" | "today" | "week" | "month" | "prev-month" | "custom";
type TypeFilter = "all" | "sent" | "received" | "swap";

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
	const hideBalance = readMigratedStorage("gatopago:hideBalance", "parmelia:hideBalance") === "1";

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
		typeParam === "sent" || typeParam === "received" || typeParam === "swap"
			? typeParam
			: "all";

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
			if (typeFilter === "swap" && t.kind !== "swap") return false;
			return true;
		});
	}, [transactions, period, fromDate, toDate, asset, typeFilter]);

	return (
		<Screen withPrimaryNav>
			<header className="mb-6">
				<p className="meli-kicker mb-3">{t("statement.eyebrow")}</p>
				<h1 className="font-display text-[36px] leading-[.94]">{t("statement.title")}</h1>
				<p className="mt-3 text-[13px] leading-relaxed text-text-muted">{t("statement.intro")}</p>
			</header>

			<SelectMenu
				label={t("statement.periodLabel")}
				value={period}
				options={PERIOD_OPTIONS.map(([value, label]) => ({ value, label: t(label) }))}
				onChange={(value) => setFilter({ period: value, ...(value !== "custom" ? { from: "", to: "" } : {}) })}
				showLabel={false}
				className="mb-3"
			/>

			{/* Custom range */}
			{period === "custom" && (
				<div className="flex gap-2.5 mb-3">
					{(
						[
							["statement.from", "from", fromDate],
							["statement.to", "to", toDate],
						] as const
					).map(([label, param, value]) => (
						<label key={label} className="flex-1 border border-border bg-surface px-3.5 py-2.5">
							<span className="block text-[11px] text-text-faint mb-0.5">{t(label)}</span>
							<input
								type="date"
								name={param}
								value={value}
								onChange={(e) => setFilter({ [param]: e.target.value })}
								className="w-full bg-transparent text-[13px] text-text scheme-light"
							/>
						</label>
					))}
				</div>
			)}

			{/* Asset + type filters */}
			<SelectMenu
				label={t("statement.assetLabel")}
				value={asset}
				options={["all", ...activeNetwork.currencies].map((currency) => ({
					value: currency,
					label: currency === "all" ? t("statement.allAssets") : currency,
				}))}
				onChange={(value) => setFilter({ asset: value })}
				showLabel={false}
				className="mb-2"
			/>
			<SelectMenu
				label={t("statement.typeLabel")}
				value={typeFilter}
				options={(
					[
						["all", "statement.allTypes"],
						["received", "statement.received"],
						["sent", "statement.sent"],
						["swap", "statement.swaps"],
					] as const
				).map(([value, label]) => ({ value, label: t(label) }))}
				onChange={(value) => setFilter({ type: value })}
				showLabel={false}
				className="mb-5"
			/>

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
					<div className="meli-paper-card flex flex-col">
						{filtered.map((tx) => <ActivityRow key={tx.id} tx={tx} hideAmount={hideBalance} onOpen={() => setSelectedTx(tx)} />)}
					</div>
				</>
			)}
			{hasMore && (
				<button
					type="button"
					disabled={isLoadingMore}
					onClick={() => void setSize((current) => current + 1)}
					className="btn btn-ghost btn-block mt-5 disabled:opacity-50"
				>
					{isLoadingMore
						? t("statement.loadingMore")
						: t("statement.loadMore")}
				</button>
			)}

			{selectedTx && <ReceiptModal tx={selectedTx} onClose={() => setSelectedTx(null)} />}
			<PrimaryNav />
		</Screen>
	);
}

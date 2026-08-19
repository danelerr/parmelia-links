import { useTranslation } from "react-i18next";
import Screen from "./Screen";
import { Skeleton } from "./Skeleton";

export default function AccountLaunchScreen({
	failed = false,
	onRetry,
}: {
	failed?: boolean;
	onRetry?: () => void;
}) {
	const { t } = useTranslation();

	return (
		<Screen animate={false} aria-busy={!failed}>
			<div aria-hidden="true">
				<header className="meli-app-header mb-6">
					<div className="flex items-center gap-2.5">
						<Skeleton className="skeleton-accent h-11 w-11 shrink-0" />
						<div>
							<Skeleton className="mb-2 h-3.5 w-24" />
							<Skeleton className="h-2.5 w-32" />
						</div>
					</div>
					<Skeleton className="h-11 w-11" />
				</header>

				<div className="meli-balance-card-app mb-6 p-5">
					<div className="mb-5 flex items-start justify-between gap-4">
						<div className="flex-1">
							<Skeleton className="mb-5 h-3 w-20" />
							<Skeleton className="mb-3 h-11 w-48 max-w-full" />
							<Skeleton className="h-2.5 w-44 max-w-[85%]" />
						</div>
						<Skeleton className="h-10 w-28 shrink-0" />
					</div>
					<Skeleton className="mb-3 h-2.5 w-full" />
					<div className="flex justify-between gap-4"><Skeleton className="h-2.5 w-20" /><Skeleton className="h-2.5 w-16" /></div>
				</div>

				<div className="meli-quick-grid mb-5">
					{Array.from({ length: 4 }, (_, index) => (
						<div key={index} className="flex min-h-[76px] flex-col items-center justify-center gap-2 border border-border bg-surface p-2">
							<Skeleton className="skeleton-accent h-8 w-8" />
							<Skeleton className="h-2.5 w-10" />
						</div>
					))}
				</div>

				<div className="mb-7 grid min-h-[88px] grid-cols-[48px_1fr_18px] items-center gap-3 border-2 border-text bg-surface p-4">
					<Skeleton className="skeleton-ink h-12 w-12" />
					<div><Skeleton className="mb-2 h-4 w-28" /><Skeleton className="h-2.5 w-44 max-w-full" /></div>
					<Skeleton className="h-5 w-5" />
				</div>

				<div className="meli-paper-card meli-paper-card--strong grid min-h-[150px] grid-cols-[1fr_84px] items-center gap-4 p-5">
					<div><Skeleton className="mb-4 h-3 w-20" /><Skeleton className="mb-3 h-8 w-36" /><Skeleton className="mb-2 h-2.5 w-full" /><Skeleton className="h-2.5 w-[72%]" /></div>
					<Skeleton className="skeleton-accent h-20 w-20" />
				</div>
			</div>

			{failed ? (
				<div className="mt-6 text-center" role="status" aria-live="polite">
					<p className="text-[13px] text-danger">{t("app.walletCheckError")}</p>
					{onRetry ? (
					<button onClick={onRetry} className="btn btn-primary btn-sm mt-4">
						{t("common.retry")}
					</button>
					) : null}
				</div>
			) : null}
		</Screen>
	);
}

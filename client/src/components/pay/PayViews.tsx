import { useTranslation } from "react-i18next";
import type { PreparedUserOperation } from "../../lib/eip712";
import { activeNetwork } from "../../lib/activeNetwork";
import { formatAmount } from "../../lib/format";
import { formatShortDate, type Transaction } from "../../lib/transactions";
import BackHeader from "../BackHeader";
import Logo from "../Logo";
import Screen from "../Screen";
import { Skeleton } from "../Skeleton";
import TxResult from "../TxResult";

export interface LinkData {
	id: string;
	amount: string;
	currency: string;
	reference: string;
	wallet: string;
	status: "pending" | "paid";
	username?: string;
}

export interface UserProfile {
	username: string;
	walletAddress: string;
	displayName?: string | null;
	socialUrl?: string | null;
}

export type ManualConfirm = {
	linkId: string;
	wallet: string;
	amount: string;
	currency: string;
	isAddress: boolean;
	username?: string;
	prepared: PreparedUserOperation;
};

function socialLabel(url: string): string {
	return url.replace(/^https:\/\/(www\.)?/, "");
}

/** Anti-phishing trust seal, kept visible on every payment surface. */
export function PayTrustBadge() {
	const { t } = useTranslation();
	return (
		<div className="flex items-center justify-center gap-2 mb-7">
			<Logo className="w-6" />
			<span className="text-[13px] text-text-muted">
				{t("pay.secureWith")} <span className="text-text font-medium">GatoPago</span>
			</span>
		</div>
	);
}

export function PayRecipient({ label, name }: { label: string; name?: string | null }) {
	const { t } = useTranslation();
	return (
		<div className="flex flex-col items-center gap-2 mb-6">
			<div className="flex h-12 w-12 items-center justify-center border-2 border-text bg-cat-500 font-display text-[18px] uppercase text-on-cat shadow-[4px_4px_0_var(--color-cat-700)]">
				{(name || label).replace(/^@/, "")[0] || "?"}
			</div>
			<h1 className="text-[14px] text-text-muted">
				{t("pay.payingTo")} <span className="text-text font-medium">{name || label}</span>
				{name && <span className="text-text-faint"> · {label}</span>}
			</h1>
		</div>
	);
}

export function ConfirmPayDestination({ tx }: { tx: ManualConfirm }) {
	const { t } = useTranslation();
	return (
		<div className="mb-3 border border-border bg-surface px-4 py-3">
			<span className="text-[12px] text-text-muted block mb-1">{t("pay.to")}</span>
			{tx.isAddress ? (
				<span className="text-[13px] text-text font-mono break-all">{tx.wallet}</span>
			) : (
				<span className="flex flex-col gap-1">
					<span className="text-[15px] text-text">@{tx.username}</span>
					<span className="text-[11px] text-text-faint font-mono break-all">{tx.wallet}</span>
				</span>
			)}
		</div>
	);
}

export function PayLoadingView({ slowConnection }: { slowConnection: boolean }) {
	const { t } = useTranslation();
	return (
		<Screen animate={false} aria-busy="true">
			<div className="flex flex-col items-center mb-7" aria-hidden="true">
				<Logo className="w-11 mb-4 opacity-75" />
				<Skeleton className="h-3.5 w-24 rounded-[6px] mb-2" />
				<Skeleton className="h-7 w-36 rounded-[9px]" />
			</div>
			<div className="mb-4 rounded-[20px] bg-surface p-6" aria-hidden="true">
				<Skeleton className="h-3 w-24 rounded-[6px] mx-auto mb-5" />
				<Skeleton className="h-14 w-48 rounded-[14px] mx-auto mb-5" />
				<Skeleton className="h-3 w-32 rounded-[6px] mx-auto" />
			</div>
			<div className="flex-1" />
			<Skeleton className="h-12 w-full rounded-full" />
			<p role="status" aria-live="polite" className={`text-center mt-4 text-[13px] ${slowConnection ? "text-text-muted" : "sr-only"}`}>
				{slowConnection ? t("pay.slowConnection") : t("common.loading")}
			</p>
		</Screen>
	);
}

export function PayLoadErrorView({ message, onHome }: { message: string; onHome: () => void }) {
	const { t } = useTranslation();
	return (
		<Screen animate={false} className="items-center justify-center gap-5 px-8 text-center">
			<Logo className="w-14 opacity-50" />
			<p className="text-text text-[16px] max-w-[280px]">{message}</p>
			<button onClick={onHome} className="btn btn-primary btn-sm">
				{t("pay.goHome")}
			</button>
		</Screen>
	);
}

export function UsernameProfileView({
	profile,
	signedIn,
	payHistory,
	onContinue,
}: {
	profile: UserProfile;
	signedIn: boolean;
	payHistory: { count: number; last: Transaction | null } | null;
	onContinue: () => void;
}) {
	const { t } = useTranslation();
	return (
		<Screen animate={false}>
			<BackHeader className="mb-6" />
			<div className="flex-1 flex flex-col items-center justify-center text-center animate-fade-up">
				<div className="mb-5 flex h-20 w-20 items-center justify-center border-2 border-text bg-cat-500 font-display text-[32px] uppercase text-on-cat shadow-[6px_6px_0_var(--color-cat-700)]">
					{(profile.displayName || profile.username)[0]}
				</div>
				<h1 className="font-display text-[28px] mb-1">{profile.displayName || `@${profile.username}`}</h1>
				{profile.displayName && <p className="text-[15px] text-text-muted mb-1">@{profile.username}</p>}
				<p className="text-[14px] text-text-muted">{t("pay.receivesPaymentsOn", { network: activeNetwork.name })}</p>
				{profile.socialUrl && (
					<a href={profile.socialUrl} target="_blank" rel="noopener noreferrer" className="mt-3 break-all px-6 text-[13px] text-info underline underline-offset-2">
						{socialLabel(profile.socialUrl)}
					</a>
				)}
				{signedIn && payHistory && (
					payHistory.count > 0 && payHistory.last ? (
						<div className="meli-paper-card meli-paper-card--strong mt-6 px-5 py-3.5">
							<p className="text-[13px] text-text-muted">{t("pay.paidBefore", { count: payHistory.count })}</p>
							<p className="text-[12px] text-text-faint mt-0.5">
								{t("pay.lastPayment", {
									amount: formatAmount(payHistory.last.amount, payHistory.last.currency),
									currency: payHistory.last.currency,
									date: formatShortDate(payHistory.last.createdAt),
								})}
							</p>
						</div>
					) : (
						<p className="mt-6 text-[13px] text-text-faint">{t("pay.firstTime")}</p>
					)
				)}
			</div>
			<button onClick={onContinue} className="btn btn-primary btn-block">
				{signedIn ? t("pay.payTo", { name: profile.username }) : t("pay.signInToPay")}
			</button>
		</Screen>
	);
}

export function PaidLinkView({ link, onHome }: { link: LinkData; onHome: () => void }) {
	const { t } = useTranslation();
	return (
		<Screen animate={false}>
			<BackHeader onClick={onHome} className="mb-6" />
			<TxResult state="success" lead={t("pay.alreadyPaid")} amount={formatAmount(link.amount, link.currency)} unit={link.currency}>
				{link.reference && <p className="text-text-muted text-[14px] mt-3">{link.reference}</p>}
			</TxResult>
		</Screen>
	);
}

// Account menu (bottom sheet). The avatar used to be a single silent link to
// Settings; this makes the account-level destinations explicit without
// touching Home's layout. Same surface language as ConfirmSheet (backdrop +
// card + fade-up), but rows instead of an amount. Card discovery lives on Home
// so the account menu contains only destinations that are available today.

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDialog } from "../hooks/useDialog";
import { SUPPORT_URL } from "../lib/support";
import type { User } from "../lib/firebase";
import { activeNetwork } from "../lib/activeNetwork";
import LinkButton from "./LinkButton";
import BrandLockup from "./brand/BrandLockup";

const ROW =
	"interactive-surface flex w-full items-center gap-3 border-b border-border px-3 py-3 text-left last:border-b-0 hover:bg-cat-50";

function RowIcon({ tone, children }: { tone: "brand" | "growth" | "info" | "pending" | "neutral"; children: ReactNode }) {
	const tones = {
		brand: "bg-cat-500/12 text-cat-300",
		growth: "bg-growth/12 text-growth",
		info: "bg-info/12 text-info",
		pending: "bg-pending/12 text-pending",
		neutral: "bg-surface-3 text-text-muted",
	} as const;
	return (
		<span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center border border-current ${tones[tone]}`}>
			{children}
		</span>
	);
}

function icon(paths: ReactNode) {
	return (
		<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
			{paths}
		</svg>
	);
}

const ICONS = {
	gear: icon(
		<>
			<circle cx="12" cy="12" r="3" />
			<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
		</>,
	),
	shield: icon(<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />),
	users: icon(
		<>
			<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
			<circle cx="9" cy="7" r="4" />
			<path d="M23 21v-2a4 4 0 0 0-3-3.87" />
			<path d="M16 3.13a4 4 0 0 1 0 7.75" />
		</>,
	),
	chat: icon(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />),
	coin: icon(
		<>
			<circle cx="12" cy="12" r="9" />
			<path d="M12 7v10M9.5 9.5a2.5 2 0 0 1 5 0c0 2-5 1-5 3a2.5 2 0 0 0 5 0" />
		</>,
	),
};

const CHEVRON = (
	<svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-faint shrink-0 ml-auto">
		<path d="m9 18 6-6-6-6" />
	</svg>
);

export default function MenuSheet({
	user,
	username,
	onClose,
}: {
	user: User;
	username: string | null;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const dialogRef = useDialog<HTMLDivElement>(onClose);

	// Portal to <body>: page containers animate with a persistent transform
	// (animate-fade-up, fill-mode both), which turns them into containing
	// blocks for position:fixed - rendered in place, this overlay would span
	// the whole DOCUMENT and the sheet would land at its bottom edge (the
	// "Home scrolls to the bottom on open" bug).
	return createPortal(
		<div
			className="dialog-backdrop fixed inset-0 z-50 flex items-end justify-center px-5 animate-fade-in"
			style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
			onClick={onClose}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-label={t("menu.aria")}
				tabIndex={-1}
				className="dialog-panel w-full max-w-sm max-h-[min(86dvh,680px)] overflow-y-auto overscroll-contain p-3 animate-sheet-up"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Bottom-sheet handle: signals "this slides / can be dismissed". */}
				<div className="sheet-handle mt-1 mb-3" aria-hidden="true" />
				<div className="px-2 pb-3"><BrandLockup compact /></div>

				{/* Identity doubles as the Perfil entry: tapping who you are opens
				    your profile (username today; name/photo/social later). */}
				<LinkButton
					to="/profile"
					onClick={onClose}
					aria-label={t("menu.profile")}
					className="mb-2 flex w-full items-center gap-3 border-2 border-text bg-surface px-3 py-2.5 text-left shadow-[4px_4px_0_var(--color-border)]"
				>
					<div className="meli-avatar shrink-0">
						{user.photoURL ? (
							<img src={user.photoURL} alt="" width="48" height="48" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
						) : (
							<span className="font-display text-[15px] uppercase text-cat-300">
								{(username || user.displayName || "?")[0]}
							</span>
						)}
					</div>
					<div className="min-w-0">
						<p className="text-[15px] truncate">{user.displayName || (username ? `@${username}` : "")}</p>
						<p className="text-[12px] text-text-faint truncate">
							{username ? `@${username}` : user.email || ""}
						</p>
					</div>
					{CHEVRON}
				</LinkButton>

				<LinkButton to="/security" onClick={onClose} className={ROW}>
					<RowIcon tone="pending">{ICONS.shield}</RowIcon>
					<span className="text-[15px]">{t("menu.security")}</span>
					{CHEVRON}
				</LinkButton>
				<LinkButton to="/contacts" onClick={onClose} className={ROW}>
					<RowIcon tone="brand">{ICONS.users}</RowIcon>
					<span className="text-[15px]">{t("menu.contacts")}</span>
					{CHEVRON}
				</LinkButton>
				<LinkButton to="/settings" onClick={onClose} className={ROW}>
					<RowIcon tone="neutral">{ICONS.gear}</RowIcon>
					<span className="text-[15px]">{t("menu.settings")}</span>
					{CHEVRON}
				</LinkButton>
				{activeNetwork.faucetUrl ? (
					<LinkButton to="/test-funds" onClick={onClose} className={ROW}>
						<RowIcon tone="pending">{ICONS.coin}</RowIcon>
						<span className="text-[15px]">{t("menu.testFunds")}</span>
						{CHEVRON}
					</LinkButton>
				) : null}
				<a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" onClick={onClose} className={ROW}>
					<RowIcon tone="info">{ICONS.chat}</RowIcon>
					<span className="text-[15px]">{t("menu.support")}</span>
					{CHEVRON}
				</a>
				<button type="button" onClick={onClose} className="btn-text w-full mt-1.5">
					{t("common.close")}
				</button>
			</div>
		</div>,
		document.body,
	);
}

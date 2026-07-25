// Account menu (bottom sheet). The avatar used to be a single silent link to
// Settings; this makes the account-level destinations explicit without
// touching Home's layout. Same surface language as ConfirmSheet (backdrop +
// card + fade-up), but rows instead of an amount. "Tarjeta" is a visible
// promise, disabled until Gnosis Pay lands.

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDialog } from "../hooks/useDialog";
import { useViewTransitionNavigate } from "../hooks/useNav";
import { SUPPORT_URL } from "../lib/support";
import type { User } from "../lib/firebase";

const ROW =
	"w-full flex items-center gap-3 px-3 py-3 rounded-[14px] hover:bg-surface-2 transition-colors text-left";

function RowIcon({ accent, children }: { accent: string; children: ReactNode }) {
	return (
		<span
			className="w-9 h-9 rounded-full flex items-center justify-center shrink-0"
			style={{ background: `${accent}22`, color: accent }}
		>
			{children}
		</span>
	);
}

function icon(paths: ReactNode) {
	return (
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
	card: icon(
		<>
			<rect x="1" y="4" width="22" height="16" rx="2" />
			<path d="M1 10h22" />
		</>,
	),
};

const CHEVRON = (
	<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-text-faint shrink-0 ml-auto">
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
	const navigate = useViewTransitionNavigate();
	const dialogRef = useDialog<HTMLDivElement>(onClose);

	function go(to: string) {
		onClose();
		navigate(to);
	}

	// Portal to <body>: page containers animate with a persistent transform
	// (animate-fade-up, fill-mode both), which turns them into containing
	// blocks for position:fixed - rendered in place, this overlay would span
	// the whole DOCUMENT and the sheet would land at its bottom edge (the
	// "Home scrolls to the bottom on open" bug).
	return createPortal(
		<div
			className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-end justify-center px-5 animate-fade-in"
			style={{ paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
			onClick={onClose}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-label={t("menu.aria")}
				tabIndex={-1}
				className="w-full max-w-sm bg-surface border border-border rounded-[24px] p-3 shadow-e3 animate-sheet-up"
				onClick={(e) => e.stopPropagation()}
			>
				{/* Bottom-sheet handle: signals "this slides / can be dismissed". */}
				<div className="w-10 h-1 rounded-full bg-border mx-auto mt-1 mb-2.5" />

				{/* Identity doubles as the Perfil entry: tapping who you are opens
				    your profile (username today; name/photo/social later). */}
				<button
					onClick={() => go("/settings#profile")}
					aria-label={t("menu.profile")}
					className="w-full flex items-center gap-3 px-3 py-2.5 mb-2 rounded-[16px] bg-surface-2/60 hover:bg-surface-2 transition-colors text-left"
				>
					<div className="w-11 h-11 rounded-full overflow-hidden border border-border bg-surface-2 flex items-center justify-center shrink-0">
						{user.photoURL ? (
							<img src={user.photoURL} alt="" width="48" height="48" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
						) : (
							<span className="text-[15px] font-display text-sky uppercase">
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
				</button>

				<button onClick={() => go("/security")} className={ROW}>
					<RowIcon accent="#efe08c">{ICONS.shield}</RowIcon>
					<span className="text-[15px]">{t("menu.security")}</span>
					{CHEVRON}
				</button>
				<button onClick={() => go("/contacts")} className={ROW}>
					<RowIcon accent="#f4a9cf">{ICONS.users}</RowIcon>
					<span className="text-[15px]">{t("menu.contacts")}</span>
					{CHEVRON}
				</button>
				<button onClick={() => go("/settings")} className={ROW}>
					<RowIcon accent="#9ce3f4">{ICONS.gear}</RowIcon>
					<span className="text-[15px]">{t("menu.settings")}</span>
					{CHEVRON}
				</button>
				<a href={SUPPORT_URL} target="_blank" rel="noopener noreferrer" onClick={onClose} className={ROW}>
					<RowIcon accent="#9ce3f4">{ICONS.chat}</RowIcon>
					<span className="text-[15px]">{t("menu.support")}</span>
					{CHEVRON}
				</a>
				<div className={`${ROW} opacity-55 cursor-default`} aria-disabled="true">
					<RowIcon accent="#efe08c">{ICONS.card}</RowIcon>
					<span className="text-[15px]">{t("menu.card")}</span>
					<span className="ml-auto text-[11px] bg-surface-2 text-text-muted rounded-full px-2.5 py-1 shrink-0">
						{t("common.soon")}
					</span>
				</div>

				<button onClick={onClose} className="btn-text w-full mt-1.5">
					{t("common.close")}
				</button>
			</div>
		</div>,
		document.body,
	);
}

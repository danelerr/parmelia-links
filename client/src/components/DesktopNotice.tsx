// One-time notice on desktop: Parmelia is built for phones, but visitors can
// keep testing here. Shown once per browser session (sessionStorage), portaled
// to <body> so it overlays everything. Mobile/tablet never see it.

import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import Logo from "./Logo";
import { useDialog } from "../hooks/useDialog";

const DISMISS_KEY = "parmelia:desktopNoticeDismissed";
// Treat wide, fine-pointer (mouse) viewports as desktop. A touchscreen laptop
// is rare enough that the wide+fine heuristic is a good, non-annoying default.
const DESKTOP_QUERY = "(min-width: 1024px) and (pointer: fine)";

// Synchronous so we can seed useState directly (no setState-in-effect).
function shouldShow() {
	try {
		if (sessionStorage.getItem(DISMISS_KEY) === "1") return false;
	} catch {
		/* storage blocked — fall through and decide by viewport */
	}
	return window.matchMedia?.(DESKTOP_QUERY).matches ?? false;
}

export default function DesktopNotice() {
	const [show, setShow] = useState(shouldShow);

	function dismiss() {
		try {
			sessionStorage.setItem(DISMISS_KEY, "1");
		} catch {
			/* private mode — fine, it just shows again next load */
		}
		setShow(false);
	}

	if (!show) return null;

	// Rendered as a child so useDialog mounts (focus/Escape) only while shown.
	return <DesktopNoticeDialog onDismiss={dismiss} />;
}

function DesktopNoticeDialog({ onDismiss }: { onDismiss: () => void }) {
	const { t } = useTranslation();
	const dialogRef = useDialog<HTMLDivElement>(onDismiss);

	return createPortal(
		<div className="fixed inset-0 z-[60] bg-black/70 backdrop-blur-sm flex items-center justify-center px-5 animate-fade-in">
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby="desktop-notice-title"
				tabIndex={-1}
				className="relative overflow-hidden w-full max-w-sm bg-surface border border-border rounded-[24px] p-7 text-center shadow-e3 animate-fade-up"
			>
				<div
					className="absolute top-0 left-0 right-0 h-1"
					style={{ background: "linear-gradient(100deg,#9ce3f4,#f4a9cf 52%,#efe08c)" }}
				/>
				<Logo className="w-12 mx-auto mb-5" />
				<h1 id="desktop-notice-title" className="font-display text-[22px] mb-2">
					{t("desktop.title")}
				</h1>
				<p className="text-[14px] text-text-muted leading-relaxed mb-6">
					{t("desktop.body")}
				</p>
				<button onClick={onDismiss} className="btn btn-primary btn-block">
					{t("desktop.continue")}
				</button>
			</div>
		</div>,
		document.body,
	);
}

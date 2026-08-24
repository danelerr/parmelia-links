import { useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useDialog } from "../hooks/useDialog";
import { usePwaInstall } from "../hooks/usePwaInstall";
import { promptPwaInstall } from "../lib/pwaInstall";

export default function PwaInstallButton() {
	const { t } = useTranslation();
	const { showInstall, isIos } = usePwaInstall();
	const [busy, setBusy] = useState(false);
	const [hidden, setHidden] = useState(false);
	const [helpOpen, setHelpOpen] = useState(false);

	if (!showInstall || hidden) return null;

	async function install() {
		if (busy) return;
		setBusy(true);
		const outcome = await promptPwaInstall();
		setBusy(false);
		if (outcome === "accepted") {
			setHidden(true);
			return;
		}
		if (outcome === "unavailable") setHelpOpen(true);
	}

	return (
		<>
			<button
				type="button"
				onClick={() => void install()}
				disabled={busy}
				aria-label={t("pwa.installAria")}
				aria-haspopup="dialog"
				aria-busy={busy}
				title={t("pwa.installAria")}
				className="pwa-install-button"
			>
				<InstallIcon />
			</button>
			{helpOpen ? (
				<InstallHelpSheet isIos={isIos} onClose={() => setHelpOpen(false)} />
			) : null}
		</>
	);
}

function InstallHelpSheet({ isIos, onClose }: { isIos: boolean; onClose: () => void }) {
	const { t } = useTranslation();
	const dialogRef = useDialog<HTMLDivElement>(onClose);

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
				aria-labelledby="pwa-install-title"
				tabIndex={-1}
				className="dialog-panel w-full max-w-sm p-6 animate-sheet-up"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="sheet-handle mb-5" aria-hidden="true" />
				<div className="mb-5 flex items-center gap-4">
					<img src="/icon-192.png" alt="" width="64" height="64" className="h-16 w-16 shrink-0" />
					<div>
						<p className="meli-kicker">PWA</p>
						<h2 id="pwa-install-title" className="mt-2 font-display text-[24px] leading-tight">
							{t("pwa.installTitle")}
						</h2>
					</div>
				</div>
				<p className="text-[13px] leading-relaxed text-text-muted">{t("pwa.installDescription")}</p>
				<p className="mt-4 border-l-4 border-cat-500 bg-cat-50 px-4 py-3 text-[13px] leading-relaxed text-text">
					{t(isIos ? "pwa.iosInstructions" : "pwa.browserInstructions")}
				</p>
				<button type="button" onClick={onClose} className="btn btn-primary btn-block mt-5">
					{t("pwa.gotIt")}
				</button>
			</div>
		</div>,
		document.body,
	);
}

function InstallIcon() {
	return (
		<svg aria-hidden="true" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" strokeLinejoin="miter">
			<path d="M12 3v11" />
			<path d="m8 10 4 4 4-4" />
			<path d="M5 14v5h14v-5" />
		</svg>
	);
}

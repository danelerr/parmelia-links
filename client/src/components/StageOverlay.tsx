// Full-screen "money in motion" overlay shown between prepare and settle.
// `label` null hides it. The spinner is hidden while the passkey prompt is up
// (`spinner={false}`) so the OS biometric sheet owns the screen.

import { createPortal } from "react-dom";
import MeliSprite from "./brand/MeliSprite";
import PixelRail from "./brand/PixelRail";

export default function StageOverlay({
	label,
	spinner = true,
}: {
	label: string | null;
	spinner?: boolean;
}) {
	if (!label) return null;
	// Portal to <body>: pages animate in with a persistent transform, which
	// would otherwise anchor this fixed overlay to the document, not the viewport.
	return createPortal(
		<div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-canvas/94 px-7 backdrop-blur-sm animate-fade-in">
			<MeliSprite
				name={spinner ? "body-courier" : "head-focused"}
				className={spinner ? "w-36" : "w-24"}
				motion={spinner ? "deliver" : "idle"}
				priority
			/>
			<div role="status" aria-live="polite" className="flex w-full max-w-[260px] flex-col items-center gap-3">
				{spinner ? <PixelRail state="active" /> : null}
				<p className="font-display text-center text-[16px] text-text">{label}</p>
			</div>
		</div>,
		document.body,
	);
}

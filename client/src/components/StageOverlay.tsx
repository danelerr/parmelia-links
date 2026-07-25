// Full-screen "money in motion" overlay shown between prepare and settle.
// `label` null hides it. The spinner is hidden while the passkey prompt is up
// (`spinner={false}`) so the OS biometric sheet owns the screen.

import { createPortal } from "react-dom";
import Logo from "./Logo";
import { Spinner } from "./icons";

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
		<div className="fixed inset-0 z-50 bg-bg/92 backdrop-blur-sm flex flex-col items-center justify-center gap-6 animate-fade-in">
			<Logo className="w-16 animate-float-glow glow-soft" />
			<div role="status" aria-live="polite" className="flex flex-col items-center gap-3">
				{spinner && <Spinner />}
				<p className="text-[16px] text-text font-display">{label}</p>
			</div>
		</div>,
		document.body,
	);
}

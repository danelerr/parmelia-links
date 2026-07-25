// Standard route-screen container: safe-area padding, phone-width column.
// Defined once so the page frame can't drift between screens.

import type { ReactNode } from "react";

export default function Screen({
	children,
	animate = true,
	className = "",
}: {
	children: ReactNode;
	/** fade-up entrance; pages that manage their own transitions pass false. */
	animate?: boolean;
	className?: string;
}) {
	return (
		<div
			className={`flex flex-col min-h-dvh px-5 pt-[calc(env(safe-area-inset-top)_+_1.5rem)] pb-[calc(env(safe-area-inset-bottom)_+_2.5rem)] w-full max-w-[460px] mx-auto${animate ? " animate-fade-up" : ""}${className ? ` ${className}` : ""}`}
		>
			{children}
		</div>
	);
}

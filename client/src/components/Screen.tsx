// Standard route-screen container: safe-area padding, phone-width column.
// Defined once so the page frame can't drift between screens.

import type { HTMLAttributes, ReactNode } from "react";

export default function Screen({
	children,
	animate = true,
	withPrimaryNav = false,
	className = "",
	...props
}: {
	children: ReactNode;
	/** fade-up entrance; pages that manage their own transitions pass false. */
	animate?: boolean;
	/** Reserves space for the persistent four-destination navigation. */
	withPrimaryNav?: boolean;
	className?: string;
} & Omit<HTMLAttributes<HTMLElement>, "children" | "className">) {
	return (
		<main
			id="main-content"
			{...props}
			className={`app-frame relative flex min-h-dvh w-full max-w-[480px] flex-col px-5 pt-[calc(env(safe-area-inset-top)_+_1.5rem)] mx-auto ${withPrimaryNav ? "pb-[calc(env(safe-area-inset-bottom)_+_7.75rem)]" : "pb-[calc(env(safe-area-inset-bottom)_+_2.5rem)]"}${animate ? " animate-fade-up" : ""}${className ? ` ${className}` : ""}`}
		>
			{children}
		</main>
	);
}

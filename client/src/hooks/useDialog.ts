// Accessible dialog behavior for the app's overlay sheets/modals.
//
// Usage: const dialogRef = useDialog<HTMLDivElement>(onClose);
// Spread on the dialog container: ref={dialogRef} role="dialog"
// aria-modal="true" aria-labelledby={titleId} tabIndex={-1}.
//
// It moves focus into the dialog on open, closes on Escape, and returns focus
// to the element that opened it on close. Mount the dialog conditionally
// ({open && <Dialog/>}) so open/close map to mount/unmount.

import { useEffect, useRef } from "react";

export function useDialog<T extends HTMLElement = HTMLDivElement>(onClose: () => void) {
	const dialogRef = useRef<T>(null);
	// Latest onClose without re-running the mount effect (callers pass inline
	// arrows; re-running would steal focus back to the dialog every render).
	const onCloseRef = useRef(onClose);
	useEffect(() => {
		onCloseRef.current = onClose;
	});

	useEffect(() => {
		const trigger =
			document.activeElement instanceof HTMLElement ? document.activeElement : null;
		const dialog = dialogRef.current;
		if (!dialog) return;
		const dialogElement: T = dialog;
		const focusableSelector = [
			"button:not([disabled])",
			"a[href]",
			"input:not([disabled])",
			"select:not([disabled])",
			"textarea:not([disabled])",
			"[tabindex]:not([tabindex='-1'])",
		].join(",");
		const focusable = () =>
			Array.from(dialogElement.querySelectorAll<HTMLElement>(focusableSelector)).filter(
				(element) => !element.hidden && element.getAttribute("aria-hidden") !== "true",
			);
		// preventScroll: moving focus into (and later back out of) the dialog must
		// never scroll the page - that's the "background jumps down on open and
		// back up on close" bug under bottom sheets.
		(dialogElement.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? focusable()[0] ?? dialogElement)
			.focus({ preventScroll: true });

		// Freeze the page behind the overlay while it's open.
		const prevOverflow = document.body.style.overflow;
		document.body.style.overflow = "hidden";
		const background: Array<{ element: HTMLElement; inert: boolean; ariaHidden: string | null }> = [];
		let branch: HTMLElement = dialogElement;
		while (branch.parentElement) {
			const parent = branch.parentElement;
			for (const sibling of Array.from(parent.children)) {
				if (!(sibling instanceof HTMLElement) || sibling === branch) continue;
				background.push({ element: sibling, inert: sibling.inert, ariaHidden: sibling.getAttribute("aria-hidden") });
				sibling.inert = true;
				sibling.setAttribute("aria-hidden", "true");
			}
			if (parent === document.body) break;
			branch = parent;
		}

		function handleKeyDown(event: KeyboardEvent) {
			const openDialogs = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']"));
			if (openDialogs.at(-1) !== dialogElement) return;
			if (event.key === "Escape") {
				event.preventDefault();
				onCloseRef.current();
				return;
			}
			if (event.key === "Tab") {
				const items = focusable();
				if (items.length === 0) {
					event.preventDefault();
					dialogElement.focus({ preventScroll: true });
					return;
				}
				const first = items[0];
				const last = items[items.length - 1];
				if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogElement)) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault();
					first.focus();
				}
			}
		}
		function keepFocusInside(event: FocusEvent) {
			const openDialogs = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']"));
			if (openDialogs.at(-1) !== dialogElement) return;
			if (!dialogElement.contains(event.target as Node)) {
				(focusable()[0] ?? dialogElement).focus({ preventScroll: true });
			}
		}
		document.addEventListener("keydown", handleKeyDown);
		document.addEventListener("focusin", keepFocusInside);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.removeEventListener("focusin", keepFocusInside);
			document.body.style.overflow = prevOverflow;
			for (const item of background) {
				item.element.inert = item.inert;
				if (item.ariaHidden === null) item.element.removeAttribute("aria-hidden");
				else item.element.setAttribute("aria-hidden", item.ariaHidden);
			}
			trigger?.focus({ preventScroll: true });
		};
	}, []);

	return dialogRef;
}

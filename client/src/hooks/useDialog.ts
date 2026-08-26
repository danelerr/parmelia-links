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

type ModalEntry = {
	dialog: HTMLElement;
	order: number;
	trigger: HTMLElement | null;
	focusFirst: () => void;
};

type BackgroundState = {
	inert: boolean;
	ariaHidden: string | null;
};

const modalEntries: ModalEntry[] = [];
const backgroundStates = new Map<HTMLElement, BackgroundState>();
let nextModalOrder = 0;
let previousBodyOverflow: string | undefined;

function bodyBranch(element: HTMLElement): HTMLElement {
	let branch = element;
	while (branch.parentElement && branch.parentElement !== document.body) {
		branch = branch.parentElement;
	}
	return branch;
}

function stackingLevel(entry: ModalEntry): number {
	const value = Number.parseInt(getComputedStyle(bodyBranch(entry.dialog)).zIndex, 10);
	return Number.isFinite(value) ? value : 0;
}

function topModal(): ModalEntry | null {
	return modalEntries.reduce<ModalEntry | null>((top, candidate) => {
		if (!top) return candidate;
		const levelDifference = stackingLevel(candidate) - stackingLevel(top);
		return levelDifference > 0 || (levelDifference === 0 && candidate.order > top.order)
			? candidate
			: top;
	}, null);
}

function restoreBackground(element: HTMLElement): void {
	const state = backgroundStates.get(element);
	if (!state) return;
	element.inert = state.inert;
	if (state.ariaHidden === null) element.removeAttribute("aria-hidden");
	else element.setAttribute("aria-hidden", state.ariaHidden);
	backgroundStates.delete(element);
}

function reconcileModalBackground(): void {
	const top = topModal();
	const activeBranch = top ? bodyBranch(top.dialog) : null;
	if (!top) {
		for (const element of [...backgroundStates.keys()]) restoreBackground(element);
		if (previousBodyOverflow !== undefined) {
			document.body.style.overflow = previousBodyOverflow;
			previousBodyOverflow = undefined;
		}
		return;
	}

	if (previousBodyOverflow === undefined) {
		previousBodyOverflow = document.body.style.overflow;
	}
	document.body.style.overflow = "hidden";

	for (const element of Array.from(document.body.children)) {
		if (!(element instanceof HTMLElement)) continue;
		if (element === activeBranch) {
			restoreBackground(element);
			continue;
		}
		if (!backgroundStates.has(element)) {
			backgroundStates.set(element, {
				inert: element.inert,
				ariaHidden: element.getAttribute("aria-hidden"),
			});
		}
		element.inert = true;
		element.setAttribute("aria-hidden", "true");
	}

	for (const element of [...backgroundStates.keys()]) {
		if (!element.isConnected) restoreBackground(element);
	}
}

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
		const focusFirst = () => {
			// preventScroll avoids the background jumping under bottom sheets.
			(dialogElement.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? focusable()[0] ?? dialogElement)
				.focus({ preventScroll: true });
		};
		const entry: ModalEntry = {
			dialog: dialogElement,
			order: nextModalOrder,
			trigger,
			focusFirst,
		};
		nextModalOrder += 1;
		modalEntries.push(entry);
		reconcileModalBackground();
		if (topModal() === entry) focusFirst();

		function handleKeyDown(event: KeyboardEvent) {
			if (topModal() !== entry) return;
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
			if (topModal() !== entry) return;
			if (!dialogElement.contains(event.target as Node)) {
				focusFirst();
			}
		}
		document.addEventListener("keydown", handleKeyDown);
		document.addEventListener("focusin", keepFocusInside);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			document.removeEventListener("focusin", keepFocusInside);
			const index = modalEntries.indexOf(entry);
			if (index >= 0) modalEntries.splice(index, 1);
			reconcileModalBackground();
			const nextTop = topModal();
			if (nextTop) {
				if (entry.trigger && nextTop.dialog.contains(entry.trigger)) {
					entry.trigger.focus({ preventScroll: true });
				} else {
					nextTop.focusFirst();
				}
			} else {
				entry.trigger?.focus({ preventScroll: true });
			}
		};
	}, []);

	return dialogRef;
}

export type PwaInstallOutcome = "accepted" | "dismissed" | "unavailable";

type PwaInstallState = {
	showInstall: boolean;
	isInstalled: boolean;
	isIos: boolean;
};

type BeforeInstallPromptEvent = Event & {
	prompt: () => Promise<void>;
	userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

type SafariNavigator = Navigator & { standalone?: boolean };

const STANDALONE_QUERY = "(display-mode: standalone)";
const INSTALLED_SESSION_KEY = "gatopago:pwa-installed-session";
const listeners = new Set<() => void>();
let deferredPrompt: BeforeInstallPromptEvent | null = null;
let initialized = false;
let installedInSession = false;
let snapshot: PwaInstallState = {
	showInstall: false,
	isInstalled: false,
	isIos: false,
};

function isStandalone() {
	return (
		window.matchMedia?.(STANDALONE_QUERY).matches === true ||
		(navigator as SafariNavigator).standalone === true
	);
}

function isIosDevice() {
	return (
		/iPad|iPhone|iPod/i.test(navigator.userAgent) ||
		(navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
	);
}

function publish(next: PwaInstallState) {
	if (
		next.showInstall === snapshot.showInstall &&
		next.isInstalled === snapshot.isInstalled &&
		next.isIos === snapshot.isIos
	) return;
	snapshot = next;
	for (const listener of listeners) listener();
}

function refresh() {
	const installed = installedInSession || isStandalone();
	publish({
		showInstall: !installed,
		isInstalled: installed,
		isIos: isIosDevice(),
	});
}

function rememberInstalled() {
	installedInSession = true;
	try {
		sessionStorage.setItem(INSTALLED_SESSION_KEY, "1");
	} catch {
		// Standalone display mode remains the source of truth when storage is unavailable.
	}
	refresh();
}

export function initPwaInstall() {
	if (initialized || typeof window === "undefined") return;
	initialized = true;
	try {
		installedInSession = sessionStorage.getItem(INSTALLED_SESSION_KEY) === "1";
	} catch {
		installedInSession = false;
	}
	refresh();

	const displayMode = window.matchMedia(STANDALONE_QUERY);
	displayMode.addEventListener("change", () => refresh());

	window.addEventListener("beforeinstallprompt", (event) => {
		// Keep the browser from showing an unrelated mini-infobar. The user can
		// launch the native prompt from the install control beside their avatar.
		event.preventDefault();
		deferredPrompt = event as BeforeInstallPromptEvent;
	});

	window.addEventListener("appinstalled", () => {
		deferredPrompt = null;
		rememberInstalled();
	});
}

export function subscribePwaInstall(listener: () => void) {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getPwaInstallState() {
	return snapshot;
}

export async function promptPwaInstall(): Promise<PwaInstallOutcome> {
	const prompt = deferredPrompt;
	if (!prompt) return "unavailable";

	// A BeforeInstallPromptEvent can only be used once. Clear it immediately so
	// a double tap cannot open two competing browser prompts.
	deferredPrompt = null;
	try {
		await prompt.prompt();
		const choice = await prompt.userChoice;
		if (choice.outcome === "accepted") rememberInstalled();
		return choice.outcome;
	} catch {
		return "unavailable";
	}
}

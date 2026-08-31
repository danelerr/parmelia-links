import { useEffect, useSyncExternalStore } from "react";
import {
	getPwaInstallState,
	initPwaInstall,
	subscribePwaInstall,
} from "../lib/pwaInstall";

const serverSnapshot = {
	showInstall: false,
	isInstalled: false,
	isIos: false,
};

export function usePwaInstall() {
	useEffect(initPwaInstall, []);
	return useSyncExternalStore(
		subscribePwaInstall,
		getPwaInstallState,
		() => serverSnapshot,
	);
}

/** Read a new GatoPago key and migrate the legacy value on first access. */
export function readMigratedStorage(primaryKey: string, legacyKey: string): string | null {
	try {
		const current = window.localStorage.getItem(primaryKey);
		if (current !== null) return current;
		const legacy = window.localStorage.getItem(legacyKey);
		if (legacy !== null) window.localStorage.setItem(primaryKey, legacy);
		return legacy;
	} catch {
		return null;
	}
}

export function writeStorage(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// Preferences remain session-only when storage is unavailable.
	}
}

export function removeMigratedStorage(primaryKey: string, legacyKey: string): void {
	try {
		window.localStorage.removeItem(primaryKey);
		window.localStorage.removeItem(legacyKey);
	} catch {
		// A blocked storage API should never block the product flow.
	}
}

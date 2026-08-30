export type RecoveryStepUpAction = "start" | "execute";

type StoredRecoveryStepUp = {
	stepUpToken: string;
	action: RecoveryStepUpAction;
	expiresAt: number;
};

const STORAGE_KEY = "gatopago:recovery-email-link-proof:v1";

export function storeRecoveryStepUp(input: {
	stepUpToken: string;
	action: RecoveryStepUpAction;
	expiresInSeconds: number;
}): void {
	if (!/^[A-Za-z0-9_-]{43}$/.test(input.stepUpToken)) return;
	try {
		const value: StoredRecoveryStepUp = {
			stepUpToken: input.stepUpToken,
			action: input.action,
			expiresAt: Date.now() + input.expiresInSeconds * 1_000,
		};
		window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(value));
	} catch {
		// Recovery can be restarted when session storage is unavailable.
	}
}

export function readRecoveryStepUp(): StoredRecoveryStepUp | null {
	try {
		const raw = window.sessionStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const value = JSON.parse(raw) as Partial<StoredRecoveryStepUp>;
		if (
			typeof value.stepUpToken !== "string" ||
			!/^[A-Za-z0-9_-]{43}$/.test(value.stepUpToken) ||
			(value.action !== "start" && value.action !== "execute") ||
			typeof value.expiresAt !== "number" ||
			value.expiresAt <= Date.now()
		) {
			clearRecoveryStepUp();
			return null;
		}
		return value as StoredRecoveryStepUp;
	} catch {
		return null;
	}
}

export function clearRecoveryStepUp(): void {
	try {
		window.sessionStorage.removeItem(STORAGE_KEY);
	} catch {
		// Nothing to clear when storage is unavailable.
	}
}

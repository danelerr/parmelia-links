import type { User } from "./firebase";
import { ApiError, apiFetch } from "./api";
import i18n from "./i18n";

type AccountOperationStatus =
	| "prepared"
	| "submitted"
	| "confirmed"
	| "failed"
	| "needs_review";

export type AccountOperationResponse = {
	operationId: string;
	kind: "account_create" | "faucet" | "recovery_propose" | "recovery_execute" | "recovery_cancel";
	status: AccountOperationStatus;
	txHash: string;
	attemptCount: number;
	errorCode: string | null;
	createdAt: string;
	updatedAt: string;
	confirmedAt: string | null;
};

export type AccountOperationGroupResponse = {
	operationId?: string;
	kind?: AccountOperationResponse["kind"];
	status?: AccountOperationStatus;
	txHash?: string;
	attemptCount?: number;
	errorCode?: string | null;
	createdAt?: string;
	updatedAt?: string;
	confirmedAt?: string | null;
	alreadyComplete?: boolean;
	operations?: Array<AccountOperationResponse & { chainId?: number; chainKey?: string }>;
};

function terminalResult(operation: AccountOperationResponse): AccountOperationResponse | null {
	if (operation.status === "confirmed") return operation;
	if (operation.status === "failed") {
		const key = operation.errorCode ? `err.${operation.errorCode}` : "";
		const message = key && i18n.exists(key) ? i18n.t(key) : i18n.t("api.genericError");
		throw new ApiError(message, { status: 500, code: operation.errorCode ?? undefined });
	}
	if (operation.status === "needs_review") {
		throw new ApiError(i18n.t("api.operationNeedsReview"), {
			status: 503,
			code: operation.errorCode ?? "SERVICE_UNAVAILABLE",
		});
	}
	return null;
}

export async function waitForAccountOperation(
	user: User,
	initial: AccountOperationResponse,
	options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<AccountOperationResponse> {
	const timeoutMs = options.timeoutMs ?? 120_000;
	const pollIntervalMs = options.pollIntervalMs ?? 1_000;
	const deadline = Date.now() + timeoutMs;
	let operation = initial;

	while (true) {
		const terminal = terminalResult(operation);
		if (terminal) return terminal;
		if (Date.now() >= deadline) {
			throw new ApiError(i18n.t("api.operationPending"), {
				status: 503,
				code: "SERVICE_UNAVAILABLE",
			});
		}

		await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs));
		try {
			operation = await apiFetch<AccountOperationResponse>(
				`/account/operations/${encodeURIComponent(operation.operationId)}`,
				{ user },
			);
		} catch (error) {
			if (error instanceof ApiError && (error.network || error.status >= 500)) continue;
			throw error;
		}
	}
}

/** Wait for every chain operation in a coordinated account-security action. */
export async function waitForAccountOperationGroup(
	user: User,
	initial: AccountOperationGroupResponse,
	options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<AccountOperationResponse[]> {
	if (initial.alreadyComplete && (!initial.operations || initial.operations.length === 0)) {
		return [];
	}
	const operations = initial.operations?.length
		? initial.operations
		: initial.operationId && initial.kind && initial.status && initial.txHash &&
			initial.attemptCount !== undefined && initial.createdAt && initial.updatedAt &&
			initial.confirmedAt !== undefined
			? [{
				operationId: initial.operationId,
				kind: initial.kind,
				status: initial.status,
				txHash: initial.txHash,
				attemptCount: initial.attemptCount,
				errorCode: initial.errorCode ?? null,
				createdAt: initial.createdAt,
				updatedAt: initial.updatedAt,
				confirmedAt: initial.confirmedAt,
			}]
			: [];
	if (operations.length === 0) {
		throw new ApiError(i18n.t("api.genericError"), { status: 500 });
	}
	return Promise.all(
		operations.map((operation) => waitForAccountOperation(user, operation, options)),
	);
}

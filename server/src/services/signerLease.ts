import type { Bindings } from "../middlewares/auth";
import { acquireLease, getSignerBlockingAccountOperation, releaseLease } from "./storage";
import { logWarn } from "./logger";

export const SIGNER_LEASE_TTL_MS = 120_000;

export class SignerLeaseBusyError extends Error {
	constructor() {
		super("The transaction signer is busy. Retry shortly.");
		this.name = "SignerLeaseBusyError";
	}
}

export function signerLeaseKey(chainId: number, signerAddress: string): string {
	if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("Invalid signer chain ID");
	if (!/^0x[0-9a-fA-F]{40}$/.test(signerAddress)) throw new Error("Invalid signer address");
	return `tx:${chainId}:${signerAddress.toLowerCase()}`;
}

export async function withSignerLease<T>(
	env: Bindings,
	input: { chainId: number; signerAddress: string; operationId?: string },
	action: () => Promise<T>,
): Promise<T> {
	const key = signerLeaseKey(input.chainId, input.signerAddress);
	const owner = await acquireLease(env, key, SIGNER_LEASE_TTL_MS);
	if (!owner) throw new SignerLeaseBusyError();

	try {
		const blocker = await getSignerBlockingAccountOperation(env, input.signerAddress);
		if (blocker && blocker.id !== input.operationId) throw new SignerLeaseBusyError();
		return await action();
	} finally {
		await releaseLease(env, key, owner).catch((error) => {
			logWarn("signer_lease_release_failed", {
				chainId: input.chainId,
				signerAddress: input.signerAddress.toLowerCase(),
				reason: error instanceof Error ? error.name : "unknown",
			});
		});
	}
}

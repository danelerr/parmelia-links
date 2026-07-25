import { createPublicClient, createWalletClient, fallback, http, type Chain, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getActiveChain } from "../chain";
import type { Bindings } from "../middlewares/auth";
import { getFaucetKey, getRecoveryGuardianKey } from "./keys";

/**
 * Build the RPC transport for the active chain. `RPC_URL` may be a single URL or
 * a comma-separated list; with multiple URLs viem fails over between them.
 */
export function buildRpcTransport(rpcUrl: string): Transport {
	const urls = rpcUrl
		.split(",")
		.map((url) => url.trim())
		.filter(Boolean);
	if (urls.length > 1) {
		return fallback(urls.map((url) => http(url)));
	}
	return http(urls[0] ?? rpcUrl);
}

/** Read-only client for the active chain. */
export function getPublicClient(env: Bindings) {
	return createPublicClient({
		chain: getActiveChain(env.CHAIN_KEY),
		transport: buildRpcTransport(env.RPC_URL),
	});
}

/** The server EOA used to deploy accounts and relay handleOps/CCTP. */
export function getServerAccount(env: Bindings) {
	return privateKeyToAccount(env.PRIVATE_KEY as `0x${string}`);
}

/** Write client signing with the server EOA. */
export function getWalletClient(env: Bindings) {
	return createWalletClient({
		chain: getActiveChain(env.CHAIN_KEY),
		transport: buildRpcTransport(env.RPC_URL),
		account: getServerAccount(env),
	});
}

export function getFaucetAccount(env: Bindings) {
	return privateKeyToAccount(getFaucetKey(env));
}

export function getFaucetWalletClient(env: Bindings) {
	return createWalletClient({
		chain: getActiveChain(env.CHAIN_KEY),
		transport: buildRpcTransport(env.RPC_URL),
		account: getFaucetAccount(env),
	});
}

export function getRecoveryGuardianAccount(env: Bindings) {
	return privateKeyToAccount(getRecoveryGuardianKey(env));
}

export function getRecoveryGuardianWalletClient(env: Bindings) {
	return createWalletClient({
		chain: getActiveChain(env.CHAIN_KEY),
		transport: buildRpcTransport(env.RPC_URL),
		account: getRecoveryGuardianAccount(env),
	});
}

/**
 * Public + wallet clients for an ARBITRARY chain (used by the cross-chain relayer
 * to call receiveMessage on the destination chain). Signs with the server EOA, so
 * that EOA must hold gas on the destination chain.
 */
export function getChainClients(env: Bindings, chain: Chain, rpcUrl: string) {
	const transport = buildRpcTransport(rpcUrl);
	return {
		publicClient: createPublicClient({ chain, transport }),
		walletClient: createWalletClient({ chain, transport, account: getServerAccount(env) }),
	};
}

/** Convenience bundle for handlers that need both clients and the server account. */
export function getClients(env: Bindings) {
	return {
		publicClient: getPublicClient(env),
		walletClient: getWalletClient(env),
		serverAccount: getServerAccount(env),
	};
}

// Tuned for fast L2s (Arbitrum blocks ~250ms): poll often so confirmation is quick,
// but cap the wait so a stuck RPC can't hang the Worker request forever.
const RECEIPT_POLL_INTERVAL_MS = 300;
const RECEIPT_TIMEOUT_MS = 60_000;

/** Wait for a tx receipt with L2-tuned polling + a hard timeout. */
export function waitForTx(
	publicClient: ReturnType<typeof getPublicClient>,
	hash: `0x${string}`,
) {
	return publicClient.waitForTransactionReceipt({
		hash,
		pollingInterval: RECEIPT_POLL_INTERVAL_MS,
		timeout: RECEIPT_TIMEOUT_MS,
	});
}

/** Thrown when a mined transaction reverted (waitForTx does NOT throw for these). */
export class TxRevertedError extends Error {
	readonly txHash: `0x${string}`;
	constructor(label: string, txHash: `0x${string}`) {
		super(`${label} transaction reverted (${txHash})`);
		this.name = "TxRevertedError";
		this.txHash = txHash;
	}
}

/**
 * waitForTx returns the receipt even when the tx mined-but-reverted; callers that
 * treat "mined" as "succeeded" report false successes. Use this after every
 * waitForTx whose effects are assumed by the code that follows.
 */
export function assertTxSuccess(
	receipt: { status: string | number },
	label: string,
	txHash: `0x${string}`,
): void {
	// viem receipts use "success" | "reverted".
	if (receipt.status !== "success") throw new TxRevertedError(label, txHash);
}

import { createPublicClient, createWalletClient, fallback, http, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getActiveChain } from "../chain";
import type { Bindings } from "../middlewares/auth";

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

/** The server EOA used to deploy accounts, fund the faucet and relay handleOps. */
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

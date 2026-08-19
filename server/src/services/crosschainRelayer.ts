// CCTP v2 cross-chain relayer (outbound Flow B). Event-driven; never throws.
//
// For each in-flight op it: (1) polls Circle's Iris attestation API by the burn's
// source tx hash; (2) once the attestation is "complete", calls receiveMessage on
// the destination chain's MessageTransmitterV2 to mint native USDC. A burn is never
// lost: receiveMessage is permissionless, so a failed mint stays retryable.
//
// Iris is a free public REST API (no key, ~35 req/s). It returns the message +
// signed attestation for a given source tx, so we don't parse MessageSent ourselves.

import { formatUnits, type Hex } from "viem";
import { getCctpChainByChainId, getNetworkConfig, NETWORKS } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { getChainById } from "../chain";
import { getChainClients, getServerAccount, waitForTx } from "./clients";
import {
	expireStaleCrosschainOps,
	listCrosschainOpsByStatus,
	recordCrosschainMintAttempt,
	recordCrosschainMintBroadcast,
	updateCrosschainOp,
	type CrosschainOpRecord,
} from "./storage";
import { notifyUser } from "./push";
import { logError, logInfo, logWarn } from "./logger";
import { discardResponseBody, readJsonBounded } from "./http";
import { SignerLeaseBusyError, withSignerLease } from "./signerLease";

const MESSAGE_TRANSMITTER_ABI = [
	{
		type: "function",
		name: "receiveMessage",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "message", type: "bytes" },
			{ name: "attestation", type: "bytes" },
		],
		outputs: [{ name: "", type: "bool" }],
	},
	{
		type: "function",
		name: "usedNonces",
		stateMutability: "view",
		inputs: [{ name: "nonce", type: "bytes32" }],
		outputs: [{ name: "", type: "uint256" }],
	},
] as const;

// Public RPC defaults per chain (override via CCTP_RPC_URLS JSON map).
const DEFAULT_RPC_BY_CHAIN: Record<number, string> = {
	421614: "https://sepolia-rollup.arbitrum.io/rpc",
	84532: "https://sepolia.base.org",
	42161: "https://arb1.arbitrum.io/rpc",
	8453: "https://mainnet.base.org",
};

const TESTNET_CHAIN_IDS = new Set([421614, 84532, 11155111, 43113]);

function irisBase(chainId: number): string {
	return TESTNET_CHAIN_IDS.has(chainId)
		? "https://iris-api-sandbox.circle.com"
		: "https://iris-api.circle.com";
}

/** Default min relayer gas (wei) to consider a destination serviceable (~0.0005 ETH). */
export const DEFAULT_MIN_RELAYER_GAS_WEI = 500_000_000_000_000n;

/** Mint attempts before an op parks as needs_support (poison-row backstop). */
const MAX_MINT_ATTEMPTS = 20;
const MINT_PENDING_GRACE_MS = 10 * 60_000;

function rpcForChain(env: Bindings, chainId: number): string {
	const active = getNetworkConfig(env.CHAIN_KEY).chainId;
	if (chainId === active && env.RPC_URL) return env.RPC_URL.split(",")[0].trim();
	if (env.CCTP_RPC_URLS) {
		try {
			const map = JSON.parse(env.CCTP_RPC_URLS) as Record<string, string>;
			if (map[String(chainId)]) return map[String(chainId)];
		} catch {
			/* ignore malformed override */
		}
	}
	return DEFAULT_RPC_BY_CHAIN[chainId] ?? "";
}

export type RelayerGasStatus = "ok" | "low" | "unknown";

/**
 * Whether the relayer holds enough native gas on `chainId` to complete a mint
 * there. "unknown" (RPC error) is a distinct state on purpose: routes that are
 * about to IRREVERSIBLY burn funds must fail closed on it — offering a burn we
 * couldn't verify we can finish degrades to "burn done, mint pending", which is
 * recoverable but must never be sold as a healthy route.
 */
export async function relayerGasStatus(
	env: Bindings,
	chainId: number,
	minWei: bigint,
): Promise<RelayerGasStatus> {
	try {
		const chain = getChainById(chainId);
		const rpc = rpcForChain(env, chainId);
		if (!chain || !rpc) return "low"; // unroutable = not serviceable
		const { publicClient } = getChainClients(env, chain, rpc);
		const balance = await publicClient.getBalance({ address: getServerAccount(env).address });
		return balance >= minWei ? "ok" : "low";
	} catch {
		return "unknown";
	}
}

type IrisMessage = { message?: string; attestation?: string; status?: string; eventNonce?: string };
const IRIS_TIMEOUT_MS = 8_000;
const IRIS_MAX_BYTES = 512 * 1024;

/** Poll Iris for a burn's attestation by source tx hash. Null while not ready. */
async function fetchAttestation(
	op: CrosschainOpRecord,
): Promise<{ message: Hex; attestation: Hex; nonce: Hex; mismatch?: never } | { mismatch: string } | null> {
	const url = `${irisBase(op.sourceChainId)}/v2/messages/${op.sourceDomain}?transactionHash=${op.sourceTxHash}`;
	const res = await fetch(url, { signal: AbortSignal.timeout(IRIS_TIMEOUT_MS) });
	if (!res.ok) {
		await discardResponseBody(res);
		return null; // 404 = not indexed yet; retry next run
	}
	const data = await readJsonBounded<{ messages?: IrisMessage[] }>(res, IRIS_MAX_BYTES);
	const complete = (data.messages ?? []).filter(
		(m) =>
			m.status === "complete" &&
			typeof m.message === "string" && m.message.startsWith("0x") &&
			typeof m.attestation === "string" && m.attestation.startsWith("0x"),
	);
	if (complete.length === 0) return null;
	let firstMismatch = "no complete message matched the operation";
	for (const msg of complete) {
		const message = msg.message as Hex;
		const mismatch = validateCctpMessage(op, message);
		if (!mismatch) {
			return { message, attestation: msg.attestation as Hex, nonce: messageNonce(message) };
		}
		firstMismatch = mismatch;
	}
	return { mismatch: firstMismatch };
}

const IN_FLIGHT: CrosschainOpRecord["status"][] = ["submitted", "waiting_attestation", "minting", "recoverable"];

export async function runCrosschainRelayer(
	env: Bindings,
	limit = 25,
): Promise<void> {
	try {
		if (!env.RPC_URL) return;

		// Operability sweep: expire abandoned checkouts, park week-old in-flight ops.
		await expireStaleCrosschainOps(env);

		const ops = await listCrosschainOpsByStatus(env, IN_FLIGHT, limit);
		if (ops.length === 0) return;

		// Alert if the relayer is low on gas on any destination it must mint to.
		const minGas = BigInt(env.CROSSCHAIN_MIN_RELAYER_GAS_WEI || DEFAULT_MIN_RELAYER_GAS_WEI.toString());
		for (const chainId of [...new Set(ops.map((o) => o.destinationChainId))]) {
			if ((await relayerGasStatus(env, chainId, minGas)) !== "ok") {
				logError("crosschain_relayer_low_gas", new Error(`relayer low/unverified gas, chain ${chainId}`), { chainId });
			}
		}

		let completed = 0;
		for (const op of ops) {
			// Handles both outbound (Arbitrum -> other chain) and inbound (other chain
			// -> Arbitrum). The mint always lands on op.destinationChainId.
			try {
				if (await processOp(env, op)) completed++;
			} catch (error) {
				logError("crosschain_relayer_op_failed", error, { opId: op.opId });
				// Record the failure; bumping updated_at also rotates the op to the
				// back of the queue so it can't starve the others.
				const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
				await updateCrosschainOp(env, op.opId, {
					attemptCount: op.attemptCount + 1,
					lastError: message,
					...(op.attemptCount + 1 >= MAX_MINT_ATTEMPTS
						? { status: "needs_support" as const, statusDetail: `gave up after ${MAX_MINT_ATTEMPTS} attempts` }
						: {}),
				}).catch(() => false);
			}
		}

		logInfo("crosschain_relayer_run", { scanned: ops.length, completed });
	} catch (error) {
		logError("crosschain_relayer_failed", error, {});
	}
}

// ---- CCTP v2 message parsing (fixed offsets, per Circle's MessageV2 /
// BurnMessageV2 layout). Used to verify a registered burn actually corresponds
// to the operation before the relayer spends gas minting it: the inbound
// register endpoint is public, so without this check anyone could point an op
// at a third party's burn tx and drain relayer gas / confuse accounting. ----

const MESSAGE_BODY_OFFSET = 148; // 4+4+4+32+32+32+32+4+4
const BURN_MESSAGE_FIXED_LENGTH = 228;
const EXPECTED_MESSAGE_LENGTH = MESSAGE_BODY_OFFSET + BURN_MESSAGE_FIXED_LENGTH;
const ZERO_BYTES32 = "0".repeat(64);

function hexBytes(hex: string, start: number, end: number): string {
	return hex.slice(2 + start * 2, 2 + end * 2);
}

function hexUint(hex: string, start: number, end: number): bigint {
	const chunk = hexBytes(hex, start, end);
	return chunk ? BigInt(`0x${chunk}`) : -1n;
}

function addressBytes32(address: string): string {
	return address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/** CCTP v2 nonce is the bytes32 header field, not Iris' presentation metadata. */
function messageNonce(message: Hex): Hex {
	return `0x${hexBytes(message, 12, 44)}` as Hex;
}

/**
 * Validate a fetched CCTP message against the op it is supposed to settle.
 * Returns null when everything matches, else a human-readable mismatch reason.
 */
export function validateCctpMessage(op: CrosschainOpRecord, message: Hex): string | null {
	const hex = message.toLowerCase();
	const byteLength = (hex.length - 2) / 2;
	if (byteLength < EXPECTED_MESSAGE_LENGTH) return "message too short";
	if (byteLength !== EXPECTED_MESSAGE_LENGTH) return "hookData must be empty";

	const source = getCctpChainByChainId(op.sourceChainId);
	const destination = getCctpChainByChainId(op.destinationChainId);
	if (!source || !destination) return "source or destination chain is not configured for CCTP";

	const version = hexUint(hex, 0, 4);
	if (version !== 1n) return `message version ${version} != 1`;

	const sourceDomain = hexUint(hex, 4, 8);
	const destinationDomain = hexUint(hex, 8, 12);
	if (sourceDomain !== BigInt(op.sourceDomain)) return `sourceDomain ${sourceDomain} != ${op.sourceDomain}`;
	if (destinationDomain !== BigInt(op.destinationDomain)) {
		return `destinationDomain ${destinationDomain} != ${op.destinationDomain}`;
	}
	if (source.domain !== op.sourceDomain || destination.domain !== op.destinationDomain) {
		return "operation domains do not match the configured chains";
	}

	const sender = hexBytes(hex, 44, 76);
	if (sender !== addressBytes32(source.tokenMessenger)) return "header sender is not the source TokenMessenger";
	const recipient = hexBytes(hex, 76, 108);
	if (recipient !== addressBytes32(destination.tokenMessenger)) {
		return "header recipient is not the destination TokenMessenger";
	}
	const destinationCaller = hexBytes(hex, 108, 140);
	const expectedCaller = op.destinationCaller
		? op.destinationCaller.toLowerCase().replace(/^0x/, "").padStart(64, "0")
		: ZERO_BYTES32;
	if (destinationCaller !== expectedCaller) return "destinationCaller does not match the operation";

	const minFinality = hexUint(hex, 140, 144);
	const finalityExecuted = hexUint(hex, 144, 148);
	if (minFinality !== 1000n && minFinality !== 2000n) return `unsupported minFinalityThreshold ${minFinality}`;
	if (minFinality !== BigInt(op.minFinalityThreshold ?? 0)) {
		return `minFinalityThreshold ${minFinality} != ${op.minFinalityThreshold}`;
	}
	if (finalityExecuted !== 1000n && finalityExecuted !== 2000n) {
		return `unsupported finalityThresholdExecuted ${finalityExecuted}`;
	}
	if (finalityExecuted < minFinality) return "finalityThresholdExecuted is below the requested threshold";

	const bodyVersion = hexUint(hex, MESSAGE_BODY_OFFSET, MESSAGE_BODY_OFFSET + 4);
	if (bodyVersion !== 1n) return `burn message version ${bodyVersion} != 1`;
	const burnToken = hexBytes(hex, MESSAGE_BODY_OFFSET + 4, MESSAGE_BODY_OFFSET + 36);
	if (burnToken !== addressBytes32(source.usdc)) return "burnToken is not source-chain USDC";
	const mintRecipient = hexBytes(hex, MESSAGE_BODY_OFFSET + 36, MESSAGE_BODY_OFFSET + 68);
	if (mintRecipient !== addressBytes32(op.recipient)) return "mintRecipient does not match the operation";

	const amount = hexUint(hex, MESSAGE_BODY_OFFSET + 68, MESSAGE_BODY_OFFSET + 100);
	// Outbound burns net-of-GatoPago-fee (the router skims first); inbound burns the full amount.
	const expected =
		op.direction === "outbound" ? BigInt(op.amountIn) - BigInt(op.gatoPagoFee || "0") : BigInt(op.amountIn);
	if (amount !== expected) return `amount ${amount} != expected ${expected}`;

	const messageSender = hexBytes(hex, MESSAGE_BODY_OFFSET + 100, MESSAGE_BODY_OFFSET + 132);
	if (op.direction === "outbound") {
		const sourceNetwork = Object.values(NETWORKS).find((network) => network.chainId === op.sourceChainId);
		if (!sourceNetwork || messageSender !== addressBytes32(sourceNetwork.contracts.crosschainRouter)) {
			return "messageSender is not the GatoPago cross-chain router";
		}
	} else if (messageSender === ZERO_BYTES32) {
		return "inbound messageSender is zero";
	}

	const maxFee = hexUint(hex, MESSAGE_BODY_OFFSET + 132, MESSAGE_BODY_OFFSET + 164);
	if (maxFee !== BigInt(op.maxFee ?? "0")) return `maxFee ${maxFee} != ${op.maxFee ?? "0"}`;
	const feeExecuted = hexUint(hex, MESSAGE_BODY_OFFSET + 164, MESSAGE_BODY_OFFSET + 196);
	if (feeExecuted > maxFee) return `feeExecuted ${feeExecuted} exceeds maxFee ${maxFee}`;
	const expirationBlock = hexUint(hex, MESSAGE_BODY_OFFSET + 196, MESSAGE_BODY_OFFSET + 228);
	if (finalityExecuted === 1000n && expirationBlock === 0n) {
		return "unfinalized message has no expirationBlock";
	}

	return null;
}

/** Advance one op as far as possible this tick. Returns true if it completed. */
async function processOp(env: Bindings, op: CrosschainOpRecord): Promise<boolean> {
	let message = op.messageBytes as Hex | null;
	let attestation = op.attestation as Hex | null;

	// 1. Fetch the attestation if we don't have it yet.
	if (!message || !attestation) {
		if (!op.sourceTxHash) return false; // nothing to poll until the burn tx is recorded
		const att = await fetchAttestation(op);
		if (!att) {
			if (op.status !== "waiting_attestation") {
				await updateCrosschainOp(env, op.opId, { status: "waiting_attestation" });
			} else {
				// Bump updated_at so this op rotates to the back of the queue.
				await updateCrosschainOp(env, op.opId, { statusDetail: op.statusDetail ?? null });
			}
			return false; // still pending; retry next run
		}
		if ("mismatch" in att) {
			logWarn("crosschain_message_mismatch", { opId: op.opId, mismatch: att.mismatch });
			await updateCrosschainOp(env, op.opId, {
				status: "needs_support",
				statusDetail: `burn does not match op: ${att.mismatch}`,
			});
			return false;
		}
		message = att.message;
		attestation = att.attestation;

		await updateCrosschainOp(env, op.opId, {
			status: "minting",
			messageBytes: message,
			attestation,
			messageNonce: att.nonce,
		});
	}

	// 2. Mint on the destination chain.
	const mismatch = validateCctpMessage(op, message);
	if (mismatch) {
		await updateCrosschainOp(env, op.opId, {
			status: "needs_support",
			statusDetail: `stored burn does not match op: ${mismatch}`,
		});
		return false;
	}
	const nonce = op.messageNonce || messageNonce(message);
	if (!op.messageNonce) await updateCrosschainOp(env, op.opId, { messageNonce: nonce });
	return mintOnDestination(env, { ...op, messageBytes: message, attestation, messageNonce: nonce });
}

async function nonceWasUsed(
	publicClient: ReturnType<typeof getChainClients>["publicClient"],
	messageTransmitter: `0x${string}`,
	nonce: Hex,
): Promise<boolean> {
	const used = await publicClient.readContract({
		address: messageTransmitter,
		abi: MESSAGE_TRANSMITTER_ABI,
		functionName: "usedNonces",
		args: [nonce],
	});
	return BigInt(used) !== 0n;
}

async function mintOnDestination(env: Bindings, op: CrosschainOpRecord): Promise<boolean> {
	const dest = getCctpChainByChainId(op.destinationChainId);
	const chain = getChainById(op.destinationChainId);
	if (!dest || !chain) {
		await updateCrosschainOp(env, op.opId, { status: "recoverable", statusDetail: "unsupported destination chain" });
		return false;
	}
	const rpc = rpcForChain(env, op.destinationChainId);
	if (!rpc) {
		await updateCrosschainOp(env, op.opId, { status: "recoverable", statusDetail: "no RPC for destination" });
		return false;
	}
	const { publicClient, walletClient } = getChainClients(env, chain, rpc);
	const nonce = (op.messageNonce || messageNonce(op.messageBytes as Hex)) as Hex;

	// The destination contract is the source of truth. This catches a previous
	// mint whose receipt/hash was lost after broadcast and prevents double-send.
	if (await nonceWasUsed(publicClient, dest.messageTransmitter, nonce)) {
		return markCompleted(env, op);
	}

	// Idempotency: if a mint was already broadcast, check its receipt before re-sending.
	if (op.destinationTxHash) {
		await recordCrosschainMintAttempt(env, op.opId, op.destinationTxHash, "unknown");
		try {
			const receipt = await publicClient.getTransactionReceipt({ hash: op.destinationTxHash as Hex });
			if (receipt.status === "success") {
				await recordCrosschainMintAttempt(env, op.opId, op.destinationTxHash, "success");
				return markCompleted(env, op);
			}
			await recordCrosschainMintAttempt(env, op.opId, op.destinationTxHash, "reverted");
			if (await nonceWasUsed(publicClient, dest.messageTransmitter, nonce)) return markCompleted(env, op);
		} catch {
			if (await nonceWasUsed(publicClient, dest.messageTransmitter, nonce)) return markCompleted(env, op);
			try {
				await publicClient.getTransaction({ hash: op.destinationTxHash as Hex });
				await recordCrosschainMintAttempt(env, op.opId, op.destinationTxHash, "pending");
				return false;
			} catch {
				// RPCs may temporarily lose a transaction. Give propagation/mining a
				// bounded grace period before replacing it.
				if (Date.now() - new Date(op.updatedAt).getTime() < MINT_PENDING_GRACE_MS) return false;
			}
		}
	}

	if (op.attemptCount + 1 > MAX_MINT_ATTEMPTS) {
		await updateCrosschainOp(env, op.opId, {
			status: "needs_support",
			statusDetail: `mint gave up after ${MAX_MINT_ATTEMPTS} attempts`,
		});
		return false;
	}

	let hash: Hex;
	try {
		hash = await withSignerLease(
			env,
			{ chainId: op.destinationChainId, signerAddress: getServerAccount(env).address },
			async () => {
				// Count only after acquiring the signer. A busy signer is normal
				// backpressure and must not consume the operation's retry budget.
				await updateCrosschainOp(env, op.opId, { attemptCount: op.attemptCount + 1 });
				return walletClient.writeContract({
					address: dest.messageTransmitter,
					abi: MESSAGE_TRANSMITTER_ABI,
					functionName: "receiveMessage",
					args: [op.messageBytes as Hex, op.attestation as Hex],
				});
			},
		);
	} catch (error) {
		if (error instanceof SignerLeaseBusyError) {
			logInfo("crosschain_mint_signer_busy", { opId: op.opId, chainId: op.destinationChainId });
			return false;
		}
		if (await nonceWasUsed(publicClient, dest.messageTransmitter, nonce)) return markCompleted(env, op);
		throw error;
	}
	await recordCrosschainMintBroadcast(env, op.opId, hash);

	const receipt = await waitForTx(publicClient, hash);
	if (receipt.status === "success") {
		await recordCrosschainMintAttempt(env, op.opId, hash, "success");
		return markCompleted(env, op);
	}
	await recordCrosschainMintAttempt(env, op.opId, hash, "reverted");
	if (await nonceWasUsed(publicClient, dest.messageTransmitter, nonce)) return markCompleted(env, op);
	await updateCrosschainOp(env, op.opId, { status: "recoverable", statusDetail: "mint reverted" });
	return false;
}

async function markCompleted(env: Bindings, op: CrosschainOpRecord): Promise<boolean> {
	// Compare-and-set from an in-flight state: a second overlapping pass can't
	// re-complete (updateCrosschainOp also refuses to ever LEAVE 'completed'),
	// and the push below fires exactly once — only for the transition winner.
	const transitioned = await updateCrosschainOp(
		env,
		op.opId,
		{ status: "completed", completedAt: new Date().toISOString() },
		{ ifStatusIn: ["submitted", "waiting_attestation", "minting", "recoverable"] },
	);
	if (!transitioned) return true; // already completed by another pass
	// Outbound: notify the sender (the destination indexer can't see this burn).
	// Inbound: the mint lands on Arbitrum, where runIndexer already credits the
	// recipient + pushes "deposit received", so we don't double-notify here.
	if (op.direction === "outbound") {
		const raw = op.amountOutExpected ?? op.amountIn;
		let pretty = raw;
		try {
			pretty = formatUnits(BigInt(raw), 6);
		} catch {
			/* keep raw if not parseable */
		}
		await notifyUser(env, op.uid, {
			title: "Envío cross-chain completado",
			body: `Tu envío de ${pretty} ${op.token} llegó a la red destino.`,
			link: "/",
		});
	}
	return true;
}

import {
	createClient,
	parseEventLogs,
	rpcSchema,
	toHex,
	type Address,
	type EIP1193RequestFn,
	type Hex,
	type Log,
} from "viem";
import {
	ERR,
	entryPointAbi,
	getNetworkConfig,
	type ErrorCode,
} from "../../../shared";
import { getActiveChain } from "../chain";
import type { Bindings } from "../middlewares/auth";
import { isTransientRpcError } from "./adaptiveLogs";
import {
	buildRpcTransport,
	getPublicClient,
	getRpcUrls,
	getServerAccount,
	getWalletClient,
} from "./clients";
import { extractErrorMessage, logInfo, logWarn } from "./logger";
import {
	PAYMASTER_POST_OP_GAS_LIMIT,
	PAYMASTER_VERIFICATION_GAS_LIMIT,
} from "./paymaster";
import { withSignerLease } from "./signerLease";
import type { PackedUserOp } from "./userOp";

export type UserOperationTransportMode = "self" | "bundler";

type UserOperationGasEstimate = {
	verificationGasLimit: bigint;
	callGasLimit: bigint;
	preVerificationGas: bigint;
	paymasterVerificationGasLimit?: bigint;
	paymasterPostOpGasLimit?: bigint;
};

export type UserOperationSendResult = {
	transport: UserOperationTransportMode;
	userOpHash: Hex;
	transactionHash: Hex | null;
};

type UserOperationReceipt = {
	userOpHash: Hex;
	transactionHash: Hex;
	blockNumber: bigint;
	blockHash: Hex;
	success: boolean;
	actualGasCost: bigint;
	actualGasUsed: bigint;
	logs: Log[];
};

export interface UserOperationTransport {
	readonly mode: UserOperationTransportMode;
	estimate(
		userOp: PackedUserOp,
		entryPoint: Address,
	): Promise<UserOperationGasEstimate>;
	send(input: {
		userOp: PackedUserOp;
		userOpHash: Hex;
		entryPoint: Address;
	}): Promise<UserOperationSendResult>;
	receipt(input: {
		userOpHash: Hex;
		transactionHash?: Hex | null;
	}): Promise<UserOperationReceipt | null>;
}

export class UserOperationTransportError extends Error {
	constructor(
		message: string,
		readonly errorCode: ErrorCode,
		readonly retryable: boolean,
		/**
		 * The RPC request may have reached the relayer/bundler even though its
		 * response was lost. Callers must reconcile, not release money claims.
		 */
		readonly possiblySubmitted = false,
		readonly transport: UserOperationTransportMode | null = null,
	) {
		super(message);
		this.name = "UserOperationTransportError";
	}
}

const USER_OPERATION_EVENT = {
	type: "event",
	name: "UserOperationEvent",
	inputs: [
		{ name: "userOpHash", type: "bytes32", indexed: true },
		{ name: "sender", type: "address", indexed: true },
		{ name: "paymaster", type: "address", indexed: true },
		{ name: "nonce", type: "uint256", indexed: false },
		{ name: "success", type: "bool", indexed: false },
		{ name: "actualGasCost", type: "uint256", indexed: false },
		{ name: "actualGasUsed", type: "uint256", indexed: false },
	],
} as const;

const HANDLE_OPS_TX_GAS_OVERHEAD = 300_000n;
const HANDLE_OPS_FALLBACK_GAS = 500_000n +
	300_000n +
	100_000n +
	PAYMASTER_VERIFICATION_GAS_LIMIT +
	PAYMASTER_POST_OP_GAS_LIMIT +
	HANDLE_OPS_TX_GAS_OVERHEAD;
const CAPABILITY_CACHE_MS = 5 * 60_000;

type BundlerCapabilityRow = {
	supported: number;
	checked_at: string;
};

type RpcUserOperation = {
	sender: Address;
	nonce: Hex;
	callData: Hex;
	callGasLimit: Hex;
	verificationGasLimit: Hex;
	preVerificationGas: Hex;
	maxFeePerGas: Hex;
	maxPriorityFeePerGas: Hex;
	signature: Hex;
	factory?: Address;
	factoryData?: Hex;
	paymaster?: Address;
	paymasterData?: Hex;
	paymasterVerificationGasLimit?: Hex;
	paymasterPostOpGasLimit?: Hex;
};

type GatoPagoBundlerRpcSchema = [
	{
		Method: "eth_chainId";
		Parameters: [];
		ReturnType: unknown;
	},
	{
		Method: "eth_supportedEntryPoints";
		Parameters: [];
		ReturnType: unknown;
	},
	{
		Method: "eth_estimateUserOperationGas";
		Parameters: [RpcUserOperation, Address];
		ReturnType: unknown;
	},
	{
		Method: "eth_sendUserOperation";
		Parameters: [RpcUserOperation, Address];
		ReturnType: unknown;
	},
	{
		Method: "eth_getUserOperationReceipt";
		Parameters: [Hex];
		ReturnType: unknown;
	},
];

type BundlerRpcRequest = EIP1193RequestFn<GatoPagoBundlerRpcSchema>;

function packedPair(value: Hex, label: string): [bigint, bigint] {
	if (!/^0x[0-9a-fA-F]{64}$/u.test(value)) {
		throw new UserOperationTransportError(
			`${label} must contain two packed uint128 values`,
			ERR.PAYMENT_FAILED,
			false,
		);
	}
	return [
		BigInt(`0x${value.slice(2, 34)}`),
		BigInt(`0x${value.slice(34, 66)}`),
	];
}

function splitInitCode(
	value: Hex,
): { factory?: Address; factoryData?: Hex } {
	if (value === "0x") return {};
	if (!/^0x[0-9a-fA-F]+$/u.test(value) || value.length < 42) {
		throw new UserOperationTransportError(
			"initCode is malformed",
			ERR.PAYMENT_FAILED,
			false,
		);
	}
	return {
		factory: value.slice(0, 42) as Address,
		factoryData: `0x${value.slice(42)}` as Hex,
	};
}

function splitPaymasterAndData(
	value: Hex,
): Pick<
	RpcUserOperation,
	| "paymaster"
	| "paymasterData"
	| "paymasterVerificationGasLimit"
	| "paymasterPostOpGasLimit"
> {
	if (value === "0x") return {};
	// address (20 bytes) + verification gas (16) + postOp gas (16).
	if (!/^0x[0-9a-fA-F]+$/u.test(value) || value.length < 106) {
		throw new UserOperationTransportError(
			"paymasterAndData is malformed",
			ERR.PAYMASTER_REJECTED,
			false,
		);
	}
	return {
		paymaster: value.slice(0, 42) as Address,
		paymasterVerificationGasLimit: toHex(
			BigInt(`0x${value.slice(42, 74)}`),
		),
		paymasterPostOpGasLimit: toHex(
			BigInt(`0x${value.slice(74, 106)}`),
		),
		paymasterData: `0x${value.slice(106)}` as Hex,
	};
}

/**
 * ERC-7769 uses the unpacked JSON representation even though EntryPoint v0.9
 * receives PackedUserOperation on-chain.
 */
export function packedUserOperationToRpc(
	userOp: PackedUserOp,
	signatureOverride?: Hex,
): RpcUserOperation {
	const [verificationGasLimit, callGasLimit] = packedPair(
		userOp.accountGasLimits,
		"accountGasLimits",
	);
	const [maxPriorityFeePerGas, maxFeePerGas] = packedPair(
		userOp.gasFees,
		"gasFees",
	);
	return {
		sender: userOp.sender,
		nonce: toHex(userOp.nonce),
		...splitInitCode(userOp.initCode),
		callData: userOp.callData,
		callGasLimit: toHex(callGasLimit),
		verificationGasLimit: toHex(verificationGasLimit),
		preVerificationGas: toHex(userOp.preVerificationGas),
		maxFeePerGas: toHex(maxFeePerGas),
		maxPriorityFeePerGas: toHex(maxPriorityFeePerGas),
		...splitPaymasterAndData(userOp.paymasterAndData),
		signature: signatureOverride ?? userOp.signature,
	};
}

function parseUserOperationReceiptFromLogs(
	logs: Log[],
	userOpHash: Hex,
): Pick<
	UserOperationReceipt,
	"success" | "actualGasCost" | "actualGasUsed"
> | null {
	const events = parseEventLogs({
		abi: [USER_OPERATION_EVENT],
		logs,
		strict: false,
	});
	const event = events.find(
		(candidate) =>
			candidate.args.userOpHash?.toLowerCase() === userOpHash.toLowerCase(),
	);
	if (!event || event.args.success === undefined) return null;
	return {
		success: Boolean(event.args.success),
		actualGasCost: BigInt(event.args.actualGasCost ?? 0n),
		actualGasUsed: BigInt(event.args.actualGasUsed ?? 0n),
	};
}

function handleOpsGasFor(userOp: PackedUserOp): bigint {
	try {
		const [verificationGas, callGas] = packedPair(
			userOp.accountGasLimits,
			"accountGasLimits",
		);
		const paymaster = splitPaymasterAndData(userOp.paymasterAndData);
		return verificationGas +
			callGas +
			userOp.preVerificationGas +
			(paymaster.paymasterVerificationGasLimit
				? BigInt(paymaster.paymasterVerificationGasLimit)
				: PAYMASTER_VERIFICATION_GAS_LIMIT) +
			(paymaster.paymasterPostOpGasLimit
				? BigInt(paymaster.paymasterPostOpGasLimit)
				: PAYMASTER_POST_OP_GAS_LIMIT) +
			HANDLE_OPS_TX_GAS_OVERHEAD;
	} catch {
		return HANDLE_OPS_FALLBACK_GAS;
	}
}

class SelfHandleOpsTransport implements UserOperationTransport {
	readonly mode = "self" as const;

	constructor(private readonly env: Bindings) {}

	async estimate(
		userOp: PackedUserOp,
		entryPoint: Address,
	): Promise<UserOperationGasEstimate> {
		void entryPoint;
		const [verificationGasLimit, callGasLimit] = packedPair(
			userOp.accountGasLimits,
			"accountGasLimits",
		);
		return {
			verificationGasLimit,
			callGasLimit,
			preVerificationGas: userOp.preVerificationGas,
		};
	}

	async send(input: {
		userOp: PackedUserOp;
		userOpHash: Hex;
		entryPoint: Address;
	}): Promise<UserOperationSendResult> {
		const publicClient = getPublicClient(this.env);
		const walletClient = getWalletClient(this.env);
		const serverAccount = getServerAccount(this.env);
		const network = getNetworkConfig(this.env.CHAIN_KEY);
		const gas = handleOpsGasFor(input.userOp);
		await publicClient.simulateContract({
			account: serverAccount.address,
			address: input.entryPoint,
			abi: entryPointAbi,
			functionName: "handleOps",
			args: [[input.userOp], serverAccount.address],
			gas,
		});
		let transactionHash: Hex;
		try {
			transactionHash = await withSignerLease(
				this.env,
				{
					chainId: network.chainId,
					signerAddress: serverAccount.address,
				},
				() =>
					walletClient.writeContract({
						address: input.entryPoint,
						abi: entryPointAbi,
						functionName: "handleOps",
						args: [[input.userOp], serverAccount.address],
						gas,
					}),
			);
		} catch (error) {
			if (isTransientRpcError(error)) {
				throw new UserOperationTransportError(
					"Relayer submission result is unknown",
					ERR.SERVICE_UNAVAILABLE,
					true,
					true,
					"self",
				);
			}
			throw error;
		}
		return {
			transport: this.mode,
			userOpHash: input.userOpHash,
			transactionHash,
		};
	}

	async receipt(input: {
		userOpHash: Hex;
		transactionHash?: Hex | null;
	}): Promise<UserOperationReceipt | null> {
		if (!input.transactionHash) return null;
		try {
			const receipt = await getPublicClient(this.env).getTransactionReceipt({
				hash: input.transactionHash,
			});
			if (!receipt.blockHash) return null;
			const logs = receipt.logs as Log[];
			const result = parseUserOperationReceiptFromLogs(
				logs,
				input.userOpHash,
			);
			if (!result) return null;
			return {
				userOpHash: input.userOpHash,
				transactionHash: input.transactionHash,
				blockNumber: receipt.blockNumber,
				blockHash: receipt.blockHash,
				...result,
				logs,
			};
		} catch (error) {
			if (isTransientRpcError(error)) return null;
			throw error;
		}
	}
}

function requestTimeoutMs(env: Bindings): number {
	const parsed = Number(env.RPC_TIMEOUT_MS);
	return Number.isSafeInteger(parsed)
		? Math.min(30_000, Math.max(1_000, parsed))
		: 10_000;
}

function endpointRequest(
	env: Bindings,
	url: string,
	slot: number,
): BundlerRpcRequest {
	const client = createClient({
		chain: getActiveChain(env.CHAIN_KEY),
		rpcSchema: rpcSchema<GatoPagoBundlerRpcSchema>(),
		transport: buildRpcTransport(url, {
			timeoutMs: requestTimeoutMs(env),
			env,
			role: "bundler",
			slotOffset: slot,
		}),
	});
	return client.request;
}

function nestedRpcCode(error: unknown): number | null {
	let current: unknown = error;
	for (let depth = 0; depth < 5; depth++) {
		if (!current || typeof current !== "object") break;
		const code = (current as { code?: unknown }).code;
		if (typeof code === "number") return code;
		current = (current as { cause?: unknown }).cause;
	}
	return null;
}

function normalizeBundlerError(error: unknown): UserOperationTransportError {
	if (error instanceof UserOperationTransportError) return error;
	const code = nestedRpcCode(error);
	const text = extractErrorMessage(error);
	if (isTransientRpcError(error)) {
		return new UserOperationTransportError(
			"Bundler is temporarily unavailable",
			ERR.BUNDLER_UNAVAILABLE,
			true,
		);
	}
	if (code === -32507 || text.includes("AA24")) {
		return new UserOperationTransportError(
			"Bundler rejected the account signature",
			ERR.PASSKEY_MISMATCH,
			false,
		);
	}
	if (
		code === -32501 ||
		code === -32508 ||
		text.includes("AA31") ||
		text.includes("AA33") ||
		text.includes("AA34")
	) {
		return new UserOperationTransportError(
			"Bundler rejected paymaster validation",
			ERR.PAYMASTER_REJECTED,
			false,
		);
	}
	return new UserOperationTransportError(
		"Bundler rejected the UserOperation",
		ERR.PAYMENT_FAILED,
		false,
	);
}

function parseRpcQuantity(value: unknown, label: string): bigint {
	if (
		typeof value !== "string" ||
		!/^0x[0-9a-fA-F]+$/u.test(value)
	) {
		throw new UserOperationTransportError(
			`Bundler returned invalid ${label}`,
			ERR.BUNDLER_UNAVAILABLE,
			true,
		);
	}
	return BigInt(value);
}

async function endpointSupports(
	env: Bindings,
	url: string,
	slot: number,
	entryPoint: Address,
): Promise<boolean> {
	const network = getNetworkConfig(env.CHAIN_KEY);
	const key = await opaqueBundlerEndpointKey(url, slot);
	const normalizedEntryPoint = entryPoint.toLowerCase();
	try {
		const cached = await env.GATOPAGO_DB.prepare(
			`SELECT supported, checked_at
			 FROM bundler_capabilities
			 WHERE endpoint_key = ? AND chain_id = ? AND entry_point = ?`,
		)
			.bind(key, network.chainId, normalizedEntryPoint)
			.first<BundlerCapabilityRow>();
		if (
			cached &&
			Date.now() - Date.parse(cached.checked_at) < CAPABILITY_CACHE_MS
		) {
			return cached.supported === 1;
		}
	} catch {
		// Capability discovery remains available during a rolling migration.
		// Never log the endpoint because it can contain an API key.
		logWarn("bundler_capability_cache_read_failed", {
			providerSlot: slot + 1,
		});
	}

	const request = endpointRequest(env, url, slot);
	const [chainIdResult, entryPointsResult] = await Promise.all([
		request({ method: "eth_chainId", params: [] }),
		request({ method: "eth_supportedEntryPoints", params: [] }),
	]);
	const supported =
		typeof chainIdResult === "string" &&
		BigInt(chainIdResult) === BigInt(network.chainId) &&
		Array.isArray(entryPointsResult) &&
		entryPointsResult.some(
			(value) =>
				typeof value === "string" &&
				value.toLowerCase() === normalizedEntryPoint,
		);
	try {
		await env.GATOPAGO_DB.prepare(
			`INSERT INTO bundler_capabilities (
				endpoint_key, chain_id, entry_point, supported, checked_at
			 ) VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(endpoint_key, chain_id, entry_point) DO UPDATE SET
			 	supported = excluded.supported,
			 	checked_at = excluded.checked_at`,
		)
			.bind(
				key,
				network.chainId,
				normalizedEntryPoint,
				supported ? 1 : 0,
				new Date().toISOString(),
			)
			.run();
	} catch {
		logWarn("bundler_capability_cache_write_failed", {
			providerSlot: slot + 1,
		});
	}
	return supported;
}

async function opaqueBundlerEndpointKey(
	url: string,
	slot: number,
): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(url),
	);
	const hash = Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `bundler:${slot}:${hash}`;
}

function isHash(value: unknown): value is Hex {
	return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/u.test(value);
}

class BundlerTransport implements UserOperationTransport {
	readonly mode = "bundler" as const;

	constructor(private readonly env: Bindings) {}

	private urls(): string[] {
		const urls = getRpcUrls(this.env, "bundler");
		if (urls.length === 0) {
			throw new UserOperationTransportError(
				"No bundler endpoint is configured",
				ERR.BUNDLER_UNAVAILABLE,
				true,
			);
		}
		return urls;
	}

	async estimate(
		userOp: PackedUserOp,
		entryPoint: Address,
	): Promise<UserOperationGasEstimate> {
		let compatible = false;
		let transient: UserOperationTransportError | null = null;
		const dummySignature =
			this.env.BUNDLER_DUMMY_SIGNATURE &&
			/^0x[0-9a-fA-F]*$/u.test(this.env.BUNDLER_DUMMY_SIGNATURE)
				? (this.env.BUNDLER_DUMMY_SIGNATURE as Hex)
				: "0x";
		for (const [slot, url] of this.urls().entries()) {
			try {
				if (!(await endpointSupports(this.env, url, slot, entryPoint))) {
					continue;
				}
				compatible = true;
				const result = await endpointRequest(this.env, url, slot)({
					method: "eth_estimateUserOperationGas",
					params: [
						packedUserOperationToRpc(userOp, dummySignature),
						entryPoint,
					],
				});
				if (!result || typeof result !== "object") {
					throw new UserOperationTransportError(
						"Bundler returned an invalid gas estimate",
						ERR.BUNDLER_UNAVAILABLE,
						true,
					);
				}
				const estimate = result as Record<string, unknown>;
				return {
					verificationGasLimit: parseRpcQuantity(
						estimate.verificationGasLimit,
						"verificationGasLimit",
					),
					callGasLimit: parseRpcQuantity(
						estimate.callGasLimit,
						"callGasLimit",
					),
					preVerificationGas: parseRpcQuantity(
						estimate.preVerificationGas,
						"preVerificationGas",
					),
					paymasterVerificationGasLimit:
						estimate.paymasterVerificationGasLimit === undefined
							? undefined
							: parseRpcQuantity(
									estimate.paymasterVerificationGasLimit,
									"paymasterVerificationGasLimit",
								),
					paymasterPostOpGasLimit:
						estimate.paymasterPostOpGasLimit === undefined
							? undefined
							: parseRpcQuantity(
									estimate.paymasterPostOpGasLimit,
									"paymasterPostOpGasLimit",
								),
				};
			} catch (error) {
				const normalized = normalizeBundlerError(error);
				if (!normalized.retryable) throw normalized;
				transient = normalized;
			}
		}
		if (!compatible && !transient) {
			throw new UserOperationTransportError(
				"Configured bundlers do not support GatoPago EntryPoint v0.9",
				ERR.BUNDLER_ENTRYPOINT_UNSUPPORTED,
				false,
			);
		}
		throw transient ??
			new UserOperationTransportError(
				"Bundler gas estimation failed",
				ERR.BUNDLER_UNAVAILABLE,
				true,
			);
	}

	async send(input: {
		userOp: PackedUserOp;
		userOpHash: Hex;
		entryPoint: Address;
	}): Promise<UserOperationSendResult> {
		let compatible = false;
		let transient: UserOperationTransportError | null = null;
		let possiblySubmitted = false;
		for (const [slot, url] of this.urls().entries()) {
			let attemptedSubmission = false;
			try {
				if (
					!(await endpointSupports(
						this.env,
						url,
						slot,
						input.entryPoint,
					))
				) {
					continue;
				}
				compatible = true;
				attemptedSubmission = true;
				const result = await endpointRequest(this.env, url, slot)({
					method: "eth_sendUserOperation",
					params: [
						packedUserOperationToRpc(input.userOp),
						input.entryPoint,
					],
				});
				if (
					!isHash(result) ||
					result.toLowerCase() !== input.userOpHash.toLowerCase()
				) {
					throw new UserOperationTransportError(
						"Bundler returned a different UserOperation hash",
						ERR.PAYMENT_FAILED,
						false,
					);
				}
				logInfo("user_operation_bundler_accepted", {
					providerSlot: slot + 1,
					userOpHash: input.userOpHash,
				});
				return {
					transport: this.mode,
					userOpHash: result,
					transactionHash: null,
				};
			} catch (error) {
				const normalized = normalizeBundlerError(error);
				if (!normalized.retryable) {
					if (possiblySubmitted) {
						throw new UserOperationTransportError(
							"Bundler submission result is unknown",
							ERR.BUNDLER_UNAVAILABLE,
							true,
							true,
							"bundler",
						);
					}
					throw normalized;
				}
				possiblySubmitted ||= attemptedSubmission;
				transient = new UserOperationTransportError(
					normalized.message,
					normalized.errorCode,
					true,
					possiblySubmitted,
					"bundler",
				);
			}
		}
		if (!compatible && !transient) {
			throw new UserOperationTransportError(
				"Configured bundlers do not support GatoPago EntryPoint v0.9",
				ERR.BUNDLER_ENTRYPOINT_UNSUPPORTED,
				false,
			);
		}
		throw transient ??
			new UserOperationTransportError(
				"Bundler submission failed",
				ERR.BUNDLER_UNAVAILABLE,
				true,
			);
	}

	async receipt(input: {
		userOpHash: Hex;
		transactionHash?: Hex | null;
	}): Promise<UserOperationReceipt | null> {
		for (const [slot, url] of this.urls().entries()) {
			try {
				const result = await endpointRequest(this.env, url, slot)({
					method: "eth_getUserOperationReceipt",
					params: [input.userOpHash],
				});
				if (result === null) continue;
				if (!result || typeof result !== "object") continue;
				const record = result as Record<string, unknown>;
				const transactionReceipt =
					record.receipt && typeof record.receipt === "object"
						? (record.receipt as Record<string, unknown>)
						: null;
				const transactionHash = transactionReceipt?.transactionHash;
				const blockHash = transactionReceipt?.blockHash;
				if (
					!isHash(record.userOpHash) ||
					record.userOpHash.toLowerCase() !==
						input.userOpHash.toLowerCase() ||
					!isHash(transactionHash) ||
					!isHash(blockHash) ||
					typeof record.success !== "boolean"
				) {
					continue;
				}
				const logs = Array.isArray(transactionReceipt?.logs)
					? (transactionReceipt.logs as Log[])
					: [];
				return {
					userOpHash: record.userOpHash,
					transactionHash,
					blockNumber: parseRpcQuantity(
						transactionReceipt?.blockNumber,
						"receipt.blockNumber",
					),
					blockHash,
					success: record.success,
					actualGasCost: parseRpcQuantity(
						record.actualGasCost,
						"actualGasCost",
					),
					actualGasUsed: parseRpcQuantity(
						record.actualGasUsed,
						"actualGasUsed",
					),
					logs,
				};
			} catch (error) {
				const normalized = normalizeBundlerError(error);
				if (!normalized.retryable) {
					logWarn("bundler_receipt_rejected", {
						providerSlot: slot + 1,
						errorCode: normalized.errorCode,
					});
				}
			}
		}
		return null;
	}
}

function fnv1aPercent(value: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return (hash >>> 0) % 100;
}

export function selectUserOperationTransport(
	env: Bindings,
	stableSubject: string,
): UserOperationTransportMode {
	if (env.RELAYER_MODE !== "bundler") return "self";
	const parsed = Number(env.BUNDLER_ROLLOUT_PERCENT ?? "100");
	const percentage = Number.isSafeInteger(parsed)
		? Math.min(100, Math.max(0, parsed))
		: 0;
	return fnv1aPercent(stableSubject) < percentage ? "bundler" : "self";
}

export function getUserOperationTransport(
	env: Bindings,
	mode: UserOperationTransportMode,
): UserOperationTransport {
	return mode === "bundler"
		? new BundlerTransport(env)
		: new SelfHandleOpsTransport(env);
}

export async function sendUserOperation(
	env: Bindings,
	mode: UserOperationTransportMode,
	input: {
		userOp: PackedUserOp;
		userOpHash: Hex;
		entryPoint: Address;
	},
): Promise<UserOperationSendResult> {
	try {
		return await getUserOperationTransport(env, mode).send(input);
	} catch (error) {
		if (
			mode === "bundler" &&
			env.BUNDLER_SELF_FALLBACK === "true" &&
			error instanceof UserOperationTransportError &&
			error.retryable &&
			!error.possiblySubmitted
		) {
			logWarn("bundler_submission_falling_back_to_self", {
				errorCode: error.errorCode,
			});
			return getUserOperationTransport(env, "self").send(input);
		}
		throw error;
	}
}

export const __test = {
	packedPair,
	splitInitCode,
	splitPaymasterAndData,
	fnv1aPercent,
	normalizeBundlerError,
	opaqueBundlerEndpointKey,
};

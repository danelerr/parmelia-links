// Cross-chain outbound (Flow B): a Parmelia user sends USDC from Arbitrum to
// another CCTP chain. CCTP v2 direct via the ParmeliaCrosschainRouter:
//   POST /crosschain/quote   → fee + amount-out estimate (stateless, deterministic)
//   POST /crosschain/prepare → builds the ERC-7821 batch (approve + bridgeUSDC) as a
//                              sponsored UserOp; the client signs it and submits via
//                              the existing /pay/submit, which records the op.
//
// Security: token is always USDC (router-immutable), amount/recipient/domains are
// validated server-side, fee is recomputed fresh (no stale quote), and the Parmelia
// fee is capped both here and on-chain (MAX_FEE_BPS = 1%).

import { Hono } from "hono";
import {
	encodeFunctionData,
	formatUnits,
	isAddress,
	keccak256,
	pad,
	parseUnits,
	toBytes,
	type Hex,
} from "viem";
import {
	CCTP_CHAINS,
	crosschainRouterAbi,
	erc20Abi,
	getCctpChainByChainId,
	getNetworkConfig,
	ERR,
} from "../../../shared";
import { AppContext, requireAuth, type Bindings } from "../middlewares/auth";
import { getPublicClient } from "../services/clients";
import { relayerGasStatus, DEFAULT_MIN_RELAYER_GAS_WEI } from "../services/crosschainRelayer";
import {
	createCrosschainOp,
	createPendingPayment,
	getCrosschainOpById,
	getCrosschainOpBySourceTx,
	getUserByUid,
	getUserByUsername,
	getUserByWallet,
	rateLimitConsume,
	updateCrosschainOp,
} from "../services/storage";
import {
	type AccountCall,
	buildSponsoredUserOp,
	encodeExecuteBatch,
	serializeBigInts,
} from "../services/userOp";
import { logError, logInfo } from "../services/logger";

const crosschainRoutes = new Hono<AppContext>();

// CCTP v2 TokenMessenger.depositForBurn - used to encode the burn tx the external
// payer signs (Flow A inbound). The client sends it raw via window.ethereum.
const cctpTokenMessengerAbi = [
	{
		type: "function",
		name: "depositForBurn",
		stateMutability: "nonpayable",
		inputs: [
			{ name: "amount", type: "uint256" },
			{ name: "destinationDomain", type: "uint32" },
			{ name: "mintRecipient", type: "bytes32" },
			{ name: "burnToken", type: "address" },
			{ name: "destinationCaller", type: "bytes32" },
			{ name: "maxFee", type: "uint256" },
			{ name: "minFinalityThreshold", type: "uint32" },
		],
		outputs: [],
	},
] as const;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";
const USDC_DECIMALS = 6;
const MAX_PARMELIA_FEE_BPS = 100n; // mirrors the contract cap (1%)
/** Comfortable maxFee cap so Fast always triggers (real CCTP fast fee ~1.3 bps). */
const CCTP_FAST_MAX_BPS = 10n; // 0.1%
/** Display-only estimate of the CCTP fast fee (Arbitrum source ~1.3 bps). */
const CCTP_FAST_FEE_EST_NUM = 13n;
const CCTP_FAST_FEE_EST_DEN = 100_000n;
/** Gas budget: approve + bridgeUSDC + CCTP depositForBurn. */
const CROSSCHAIN_CALL_GAS_LIMIT = 900000n;

type Mode = "fast" | "standard";

function ceilDiv(a: bigint, b: bigint): bigint {
	return b === 0n ? 0n : (a + b - 1n) / b;
}

function isPaused(env: Bindings): boolean {
	return env.CROSSCHAIN_PAUSED === "true";
}

/** Per-route feature flag: chainIds to hide (source or destination). */
function disabledChains(env: Bindings): Set<number> {
	return new Set(
		(env.CROSSCHAIN_DISABLED_CHAINS || "")
			.split(",")
			.map((s) => Number(s.trim()))
			.filter((n) => Number.isFinite(n) && n > 0),
	);
}

function minRelayerGas(env: Bindings): bigint {
	try {
		return BigInt(env.CROSSCHAIN_MIN_RELAYER_GAS_WEI || DEFAULT_MIN_RELAYER_GAS_WEI.toString());
	} catch {
		return DEFAULT_MIN_RELAYER_GAS_WEI;
	}
}

function isEnabled(env: Bindings): boolean {
	if (isPaused(env)) return false;
	const net = getNetworkConfig(env.CHAIN_KEY);
	const router = net.contracts.crosschainRouter;
	return !!router && router !== ZERO_ADDRESS && !!getCctpChainByChainId(net.chainId);
}

// Inbound does NOT use our router (the external payer calls CCTP's TokenMessenger
// directly). It only needs the active chain to be a CCTP destination + the relayer
// (which has gas on Arbitrum) to complete the mint.
function isInboundEnabled(env: Bindings): boolean {
	if (isPaused(env)) return false;
	return !!getCctpChainByChainId(getNetworkConfig(env.CHAIN_KEY).chainId);
}

/** Deterministic fee + amount math (no persisted quote; recomputed at prepare). */
function computeAmounts(crosschainFeeBps: string | undefined, amountRaw: bigint, mode: Mode) {
	let feeBps = BigInt(crosschainFeeBps || "0");
	if (feeBps < 0n) feeBps = 0n;
	if (feeBps > MAX_PARMELIA_FEE_BPS) feeBps = MAX_PARMELIA_FEE_BPS;
	const parmeliaFee = (amountRaw * feeBps) / 10_000n;
	const net = amountRaw - parmeliaFee;
	const cctpFee = mode === "fast" ? (net * CCTP_FAST_FEE_EST_NUM) / CCTP_FAST_FEE_EST_DEN : 0n;
	const maxFee = mode === "fast" ? ceilDiv(net * CCTP_FAST_MAX_BPS, 10_000n) : 0n;
	const minFinalityThreshold = mode === "fast" ? 1000 : 2000;
	const amountOut = net > cctpFee ? net - cctpFee : 0n;
	return { feeBps, parmeliaFee, net, cctpFee, maxFee, minFinalityThreshold, amountOut };
}

// GET /crosschain/config - what the UI may offer.
crosschainRoutes.get("/config", requireAuth, async (c) => {
	const net = getNetworkConfig(c.env.CHAIN_KEY);
	const source = getCctpChainByChainId(net.chainId);
	const enabled = isEnabled(c.env);
	let destinations: { chainId: number; name: string; domain: number }[] = [];
	if (enabled) {
		const disabled = disabledChains(c.env);
		const minGas = minRelayerGas(c.env);
		const candidates = Object.values(CCTP_CHAINS).filter(
			(ch) => ch.chainId !== net.chainId && !disabled.has(ch.chainId),
		);
		// Only offer destinations we VERIFIED the relayer can serve: "unknown"
		// (RPC error) counts as unavailable — honest availability beats optimism
		// when the source-side action is an irreversible burn.
		const serviceable = await Promise.all(
			candidates.map((ch) => relayerGasStatus(c.env, ch.chainId, minGas)),
		);
		destinations = candidates
			.filter((_, i) => serviceable[i] === "ok")
			.map((ch) => ({ chainId: ch.chainId, name: ch.name, domain: ch.domain }));
	}
	return c.json({
		enabled,
		token: "USDC",
		source: source ? { chainId: source.chainId, name: source.name, domain: source.domain } : null,
		destinations,
	});
});

crosschainRoutes.post("/quote", requireAuth, async (c) => {
	const requestId = c.get("requestId");
	try {
		const net = getNetworkConfig(c.env.CHAIN_KEY);
		if (!isEnabled(c.env)) {
			return c.json({ error: "Los envíos entre redes no están disponibles.", error_code: ERR.BRIDGE_DISABLED, requestId }, 400);
		}
		const body = (await c.req.json()) as Record<string, unknown>;
		const dest = getCctpChainByChainId(Number(body.destinationChainId));
		if (!dest || dest.chainId === net.chainId) {
			return c.json({ error: "Red destino no soportada.", error_code: ERR.UNSUPPORTED_CHAIN, requestId }, 400);
		}
		const mode: Mode = body.mode === "standard" ? "standard" : "fast";

		let amountRaw: bigint;
		try {
			amountRaw = parseUnits(typeof body.amount === "string" ? body.amount.trim() : "", USDC_DECIMALS);
		} catch {
			return c.json({ error: "Monto inválido.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
		}
		if (amountRaw <= 0n) {
			return c.json({ error: "El monto debe ser mayor a 0.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
		}

		const a = computeAmounts(c.env.PARMELIA_CROSSCHAIN_FEE_BPS, amountRaw, mode);
		if (a.amountOut <= 0n) {
			return c.json({ error: "El monto no cubre las comisiones.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
		}
		return c.json({
			token: "USDC",
			mode,
			destinationChainId: dest.chainId,
			amountIn: formatUnits(amountRaw, USDC_DECIMALS),
			parmeliaFee: formatUnits(a.parmeliaFee, USDC_DECIMALS),
			parmeliaFeeBps: Number(a.feeBps),
			cctpFeeEstimated: formatUnits(a.cctpFee, USDC_DECIMALS),
			amountOutEstimated: formatUnits(a.amountOut, USDC_DECIMALS),
			estimatedMinutes: mode === "fast" ? 1 : 15,
			requestId,
		});
	} catch (error) {
		logError("crosschain_quote_failed", error, { requestId });
		return c.json({ error: "No pudimos cotizar el envío. Intenta de nuevo.", error_code: ERR.BRIDGE_QUOTE_FAILED, requestId }, 500);
	}
});

crosschainRoutes.post("/prepare", requireAuth, async (c) => {
	const requestId = c.get("requestId");
	try {
		const user = c.get("user")!;
		const net = getNetworkConfig(c.env.CHAIN_KEY);
		if (!isEnabled(c.env)) {
			return c.json({ error: "Los envíos entre redes no están disponibles.", error_code: ERR.BRIDGE_DISABLED, requestId }, 400);
		}

		const body = (await c.req.json()) as Record<string, unknown>;
		const source = getCctpChainByChainId(net.chainId)!;
		const dest = getCctpChainByChainId(Number(body.destinationChainId));
		if (!dest || dest.chainId === net.chainId) {
			return c.json({ error: "Red destino no soportada.", error_code: ERR.UNSUPPORTED_CHAIN, requestId }, 400);
		}
		const mode: Mode = body.mode === "standard" ? "standard" : "fast";

		const recipient = typeof body.recipient === "string" ? body.recipient.trim() : "";
		if (!isAddress(recipient)) {
			return c.json({ error: "Dirección destino inválida.", error_code: ERR.INVALID_RECIPIENT, requestId }, 400);
		}

		let amountRaw: bigint;
		try {
			amountRaw = parseUnits(typeof body.amount === "string" ? body.amount.trim() : "", USDC_DECIMALS);
		} catch {
			return c.json({ error: "Monto inválido.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
		}
		if (amountRaw <= 0n) {
			return c.json({ error: "El monto debe ser mayor a 0.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
		}

		const profile = await getUserByUid(c.env, user.sub);
		const account = profile?.walletAddress as `0x${string}` | undefined;
		if (!account) {
			return c.json({ error: "Necesitas una cuenta para enviar.", error_code: ERR.NO_WALLET, requestId }, 400);
		}

		const usdc = net.contracts.usdc;
		const publicClient = getPublicClient(c.env);
		const balance = (await publicClient.readContract({
			address: usdc,
			abi: erc20Abi,
			functionName: "balanceOf",
			args: [account],
		})) as bigint;
		if (balance < amountRaw) {
			return c.json(
				{
					error: `Saldo insuficiente (tienes ${formatUnits(balance, USDC_DECIMALS)} USDC).`,
					error_code: ERR.INSUFFICIENT_BALANCE,
					requestId,
				},
				400,
			);
		}

		const a = computeAmounts(c.env.PARMELIA_CROSSCHAIN_FEE_BPS, amountRaw, mode);
		if (a.amountOut <= 0n) {
			return c.json({ error: "El monto no cubre las comisiones.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
		}

		// Route guard: hidden chain, or relayer gas on the destination not VERIFIED
		// ok (fail closed on RPC errors — this route ends in an irreversible burn).
		if (
			disabledChains(c.env).has(dest.chainId) ||
			(await relayerGasStatus(c.env, dest.chainId, minRelayerGas(c.env))) !== "ok"
		) {
			return c.json({ error: "Esa red no está disponible ahora.", error_code: ERR.CROSSCHAIN_UNAVAILABLE, requestId }, 400);
		}

		const router = net.contracts.crosschainRouter;
		const opId = keccak256(toBytes(crypto.randomUUID()));
		const mintRecipient = pad(recipient as Hex, { size: 32 });

		const approveData = encodeFunctionData({
			abi: erc20Abi,
			functionName: "approve",
			args: [router, amountRaw],
		});
		const bridgeData = encodeFunctionData({
			abi: crosschainRouterAbi,
			functionName: "bridgeUSDC",
			args: [
				opId,
				amountRaw,
				a.parmeliaFee,
				dest.domain,
				mintRecipient,
				a.maxFee,
				a.minFinalityThreshold,
			],
		});

		const calls: AccountCall[] = [
			{ target: usdc, value: 0n, data: approveData },
			{ target: router, value: 0n, data: bridgeData },
		];
		const executeCalldata = encodeExecuteBatch(calls);
		const { userOp, userOpHash } = await buildSponsoredUserOp(c.env, {
			sender: account,
			callData: executeCalldata,
			callGasLimit: CROSSCHAIN_CALL_GAS_LIMIT,
		});

		// Register the op BEFORE the user signs the burn (CROSSCHAIN_DESIGN §flow):
		// if the Worker dies between broadcasting the burn and recording it, this
		// row is the trace that lets the relayer/ops complete the mint. /pay/submit
		// flips it to 'submitted' with the tx hash right after broadcast; abandoned
		// 'quoted' rows expire after 24h.
		const nowIso = new Date().toISOString();
		await createCrosschainOp(c.env, {
			opId,
			uid: user.sub,
			direction: "outbound",
			provider: "cctp",
			cctpMode: mode,
			sourceChainId: net.chainId,
			destinationChainId: dest.chainId,
			sourceDomain: source.domain,
			destinationDomain: dest.domain,
			destinationCaller: null,
			sourceTxHash: null,
			destinationTxHash: null,
			messageNonce: null,
			messageBytes: null,
			attestation: null,
			token: "USDC",
			amountIn: amountRaw.toString(),
			parmeliaFee: a.parmeliaFee.toString(),
			maxFee: a.maxFee.toString(),
			minFinalityThreshold: a.minFinalityThreshold,
			cctpFeeEstimated: a.cctpFee.toString(),
			amountOutExpected: a.amountOut.toString(),
			recipient,
			status: "quoted",
			statusDetail: null,
			createdAt: nowIso,
			updatedAt: nowIso,
			completedAt: null,
		});

		await createPendingPayment(c.env, {
			userOpHash,
			linkId: null,
			uid: user.sub,
			amount: formatUnits(amountRaw, USDC_DECIMALS),
			currency: "CROSSCHAIN",
			wallet: account,
			senderAddress: account,
			userOp: serializeBigInts(userOp) as Record<string, unknown>,
			meta: {
				opId,
				direction: "outbound",
				cctpMode: mode,
				sourceChainId: net.chainId,
				destinationChainId: dest.chainId,
				sourceDomain: source.domain,
				destinationDomain: dest.domain,
				recipient,
				amountIn: amountRaw.toString(),
				parmeliaFee: a.parmeliaFee.toString(),
				maxFee: a.maxFee.toString(),
				minFinalityThreshold: a.minFinalityThreshold,
				cctpFeeEstimated: a.cctpFee.toString(),
				amountOutExpected: a.amountOut.toString(),
			},
		});

		logInfo("crosschain_prepare_created", {
			requestId,
			uid: user.sub,
			userOpHash,
			opId,
			destinationChainId: dest.chainId,
			mode,
		});

		return c.json({
			userOpHash,
			// For GET /crosschain/status/:opId once the burn is submitted.
			opId,
			credentialId: profile?.credentialId ?? null,
			summary: {
				token: "USDC",
				amountIn: formatUnits(amountRaw, USDC_DECIMALS),
				amountOutEstimated: formatUnits(a.amountOut, USDC_DECIMALS),
				parmeliaFee: formatUnits(a.parmeliaFee, USDC_DECIMALS),
				destinationChainId: dest.chainId,
				destinationName: dest.name,
				recipient,
				mode,
				estimatedMinutes: mode === "fast" ? 1 : 15,
			},
		});
	} catch (error) {
		logError("crosschain_prepare_failed", error, { requestId });
		return c.json({ error: "No pudimos preparar el envío. Intenta de nuevo.", error_code: ERR.CROSSCHAIN_PREPARE_FAILED, requestId }, 500);
	}
});

// ===== Inbound (Flow A): an EXTERNAL wallet pays a Parmelia user. Public routes
// (the payer has no Parmelia account). The payer calls CCTP's TokenMessenger
// directly on the source chain; the relayer mints on Arbitrum (destination). =====

// GET /crosschain/inbound/config - source chains the checkout may offer.
crosschainRoutes.get("/inbound/config", async (c) => {
	const net = getNetworkConfig(c.env.CHAIN_KEY);
	const dest = getCctpChainByChainId(net.chainId);
	// Inbound mints on the active chain (Arbitrum); gate on the relayer's gas there.
	const enabled =
		isInboundEnabled(c.env) && (await relayerGasStatus(c.env, net.chainId, minRelayerGas(c.env))) === "ok";
	const disabled = disabledChains(c.env);
	const sources = enabled
		? Object.values(CCTP_CHAINS)
				.filter((ch) => ch.chainId !== net.chainId && !disabled.has(ch.chainId))
				.map((ch) => ({ chainId: ch.chainId, name: ch.name, domain: ch.domain }))
		: [];
	return c.json({
		enabled,
		token: "USDC",
		destination: dest ? { chainId: dest.chainId, name: dest.name, domain: dest.domain } : null,
		sources,
	});
});

// POST /crosschain/inbound/prepare - resolve recipient + return the exact CCTP
// depositForBurn the external wallet must sign. Creates a pending op for tracking.
crosschainRoutes.post("/inbound/prepare", async (c) => {
	const requestId = c.get("requestId");
	try {
		// Public endpoint (the external payer has no Parmelia session): cap the
		// per-IP rate so it can't be used to spam operation rows.
		const ip = c.req.header("CF-Connecting-IP") || "unknown";
		if (!(await rateLimitConsume(c.env, "cc-in-prepare", ip, 20, 3600, { failClosed: true }))) {
			return c.json({ error: "Demasiados intentos. Espera un momento.", error_code: ERR.RATE_LIMITED, requestId }, 429);
		}

		const net = getNetworkConfig(c.env.CHAIN_KEY);
		if (!isInboundEnabled(c.env)) {
			return c.json({ error: "No disponible en esta red.", error_code: ERR.BRIDGE_DISABLED, requestId }, 400);
		}
		const dest = getCctpChainByChainId(net.chainId)!;
		const body = (await c.req.json()) as Record<string, unknown>;

		const sourceCctp = getCctpChainByChainId(Number(body.sourceChainId));
		if (!sourceCctp || sourceCctp.chainId === net.chainId) {
			return c.json({ error: "Red origen no soportada.", error_code: ERR.UNSUPPORTED_CHAIN, requestId }, 400);
		}
		// Route guard: hidden source, or relayer gas on Arbitrum not VERIFIED ok
		// (fail closed — the external payer is about to burn on the source chain).
		if (
			disabledChains(c.env).has(sourceCctp.chainId) ||
			(await relayerGasStatus(c.env, net.chainId, minRelayerGas(c.env))) !== "ok"
		) {
			return c.json({ error: "Esa ruta no está disponible ahora.", error_code: ERR.CROSSCHAIN_UNAVAILABLE, requestId }, 400);
		}
		const mode: Mode = body.mode === "standard" ? "standard" : "fast";

		// Resolve the recipient (Parmelia user) from a username or their address.
		const recipientInput = typeof body.recipient === "string" ? body.recipient.trim() : "";
		const recipientUser = isAddress(recipientInput)
			? await getUserByWallet(c.env, recipientInput)
			: await getUserByUsername(c.env, recipientInput);
		if (!recipientUser?.walletAddress) {
			return c.json({ error: "Destinatario no encontrado.", error_code: ERR.USER_NOT_FOUND, requestId }, 404);
		}
		const recipientAddress = recipientUser.walletAddress as `0x${string}`;

		let amountRaw: bigint;
		try {
			amountRaw = parseUnits(typeof body.amount === "string" ? body.amount.trim() : "", USDC_DECIMALS);
		} catch {
			return c.json({ error: "Monto inválido.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
		}
		if (amountRaw <= 0n) {
			return c.json({ error: "El monto debe ser mayor a 0.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
		}

		// Inbound v1 charges no Parmelia fee (feeBps "0"); only the CCTP fast fee.
		const a = computeAmounts("0", amountRaw, mode);
		if (a.amountOut <= 0n) {
			return c.json({ error: "El monto no cubre la comisión de red.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
		}

		const opId = crypto.randomUUID();
		const mintRecipient = pad(recipientAddress, { size: 32 });
		const now = new Date().toISOString();

		// Pre-encode the two txs the external wallet must send (raw, via window.ethereum).
		const approveData = encodeFunctionData({
			abi: erc20Abi,
			functionName: "approve",
			args: [sourceCctp.tokenMessenger, amountRaw],
		});
		const burnData = encodeFunctionData({
			abi: cctpTokenMessengerAbi,
			functionName: "depositForBurn",
			args: [
				amountRaw,
				dest.domain,
				mintRecipient,
				sourceCctp.usdc,
				ZERO_BYTES32 as `0x${string}`,
				a.maxFee,
				a.minFinalityThreshold,
			],
		});

		await createCrosschainOp(c.env, {
			opId,
			uid: recipientUser.uid,
			direction: "inbound",
			provider: "cctp",
			cctpMode: mode,
			sourceChainId: sourceCctp.chainId,
			destinationChainId: net.chainId,
			sourceDomain: sourceCctp.domain,
			destinationDomain: dest.domain,
			destinationCaller: ZERO_BYTES32,
			sourceTxHash: null,
			destinationTxHash: null,
			messageNonce: null,
			messageBytes: null,
			attestation: null,
			token: "USDC",
			amountIn: amountRaw.toString(),
			parmeliaFee: "0",
			maxFee: a.maxFee.toString(),
			minFinalityThreshold: a.minFinalityThreshold,
			cctpFeeEstimated: a.cctpFee.toString(),
			amountOutExpected: a.amountOut.toString(),
			recipient: recipientAddress,
			status: "pending_signature",
			statusDetail: null,
			createdAt: now,
			updatedAt: now,
			completedAt: null,
		});

		return c.json({
			opId,
			sourceChainId: sourceCctp.chainId,
			// Ready-to-send txs (the wallet must be on sourceChainId): approve, then burn.
			approveTx: { to: sourceCctp.usdc, data: approveData },
			burnTx: { to: sourceCctp.tokenMessenger, data: burnData },
			summary: {
				recipientName: recipientUser.username,
				amountIn: formatUnits(amountRaw, USDC_DECIMALS),
				amountOutEstimated: formatUnits(a.amountOut, USDC_DECIMALS),
				mode,
				estimatedMinutes: mode === "fast" ? 1 : 15,
			},
		});
	} catch (error) {
		logError("crosschain_inbound_prepare_failed", error, { requestId });
		return c.json({ error: "No pudimos preparar el cobro. Intenta de nuevo.", error_code: ERR.CROSSCHAIN_PREPARE_FAILED, requestId }, 500);
	}
});

// POST /crosschain/inbound/register - the checkout reports the burn tx; the relayer
// then polls Iris and completes the mint on Arbitrum. Public and therefore
// hardened: one op per burn tx (dedupe), compare-and-set from pending_signature
// only, and the relayer independently verifies the burn's message (domains,
// mintRecipient, amount) against the op before spending gas on the mint.
crosschainRoutes.post("/inbound/register", async (c) => {
	const requestId = c.get("requestId");
	const registerIp = c.req.header("CF-Connecting-IP") || "unknown";
	if (!(await rateLimitConsume(c.env, "cc-in-register", registerIp, 30, 3600, { failClosed: true }))) {
		return c.json({ error: "Demasiados intentos. Espera un momento.", error_code: ERR.RATE_LIMITED, requestId }, 429);
	}
	const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
	const opId = typeof body.opId === "string" ? body.opId : "";
	const sourceTxHash = typeof body.sourceTxHash === "string" ? body.sourceTxHash.trim().toLowerCase() : "";
	if (!opId || !/^0x[0-9a-f]{64}$/.test(sourceTxHash)) {
		return c.json({ error: "Datos inválidos.", error_code: ERR.INVALID_TX_HASH, requestId }, 400);
	}
	const op = await getCrosschainOpById(c.env, opId);
	if (!op || op.direction !== "inbound") {
		return c.json({ error: "Operación no encontrada.", error_code: ERR.INTENT_NOT_FOUND, requestId }, 404);
	}

	// A burn tx settles exactly one operation. Without this, the same third-party
	// burn could be attached to many ops to spam the relayer queue.
	const existing = await getCrosschainOpBySourceTx(c.env, sourceTxHash);
	if (existing && existing.opId !== opId) {
		return c.json({ error: "Ese tx ya está registrado.", error_code: ERR.TX_ALREADY_REGISTERED, requestId }, 409);
	}

	if (op.status === "pending_signature") {
		await updateCrosschainOp(
			c.env,
			opId,
			{ status: "submitted", sourceTxHash },
			{ ifStatusIn: ["pending_signature"] },
		);
	}
	const fresh = await getCrosschainOpById(c.env, opId);
	return c.json({ ok: true, opId, status: fresh?.status ?? op.status });
});

// GET /crosschain/inbound/status/:opId - the checkout polls this until completed.
crosschainRoutes.get("/inbound/status/:opId", async (c) => {
	const op = await getCrosschainOpById(c.env, c.req.param("opId"));
	if (!op) return c.json({ error: "No encontrada", error_code: ERR.INTENT_NOT_FOUND }, 404);
	return c.json({
		status: op.status,
		destinationTxHash: op.destinationTxHash,
		amountOutExpected: op.amountOutExpected,
	});
});

// GET /crosschain/status/:opId - OUTBOUND tracking for the sender: the burn tx
// confirms in-app, but the mint on the destination lands minutes later via the
// relayer; this lets the app show honest progress instead of only a push.
crosschainRoutes.get("/status/:opId", requireAuth, async (c) => {
	const user = c.get("user")!;
	const op = await getCrosschainOpById(c.env, c.req.param("opId") ?? "");
	if (!op) return c.json({ error: "No encontrada", error_code: ERR.INTENT_NOT_FOUND }, 404);
	if (op.uid !== user.sub) {
		return c.json({ error: "Unauthorized", error_code: ERR.WRONG_ACCOUNT }, 403);
	}
	return c.json({
		opId: op.opId,
		direction: op.direction,
		status: op.status,
		statusDetail: op.statusDetail,
		sourceTxHash: op.sourceTxHash,
		destinationTxHash: op.destinationTxHash,
		destinationChainId: op.destinationChainId,
		amountOutExpected: op.amountOutExpected,
		updatedAt: op.updatedAt,
	});
});

export default crosschainRoutes;

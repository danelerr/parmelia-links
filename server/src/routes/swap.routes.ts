// Internal swaps on Arbitrum (Módulo 2).
//
// Flow: POST /swap/quote → short-lived quote persisted in D1 →
//       POST /swap/prepare → re-validated route, Universal Router calldata is
//       built SERVER-SIDE from the stored quote (never from client input),
//       wrapped in an ERC-7821 batch (Permit2 exact-amount approvals + swap)
//       and turned into a sponsored UserOperation. The client then signs the
//       userOpHash biometrically and submits through the existing /pay/submit.
//
// Security invariants:
//   - tokens resolved only from the shared whitelist (symbols, not addresses)
//   - recipient is ALWAYS the user's own smart account (from their profile)
//   - slippage, deadline and minimumAmountOut are mandatory and server-computed
//   - approvals are exact-amount with a short Permit2 expiration - never infinite
//   - quotes expire (60s) and are re-checked against the pool before preparing

import { Hono } from "hono";
import { formatUnits, parseUnits, type Hex } from "viem";
import { erc20Abi, getNetworkConfig, getTokenBySymbol, ERR } from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import { getPublicClient } from "../services/clients";
import {
	createPendingPayment,
	createSwapQuote,
	getSwapQuote,
	getUserByUid,
	updateSwapQuoteStatus,
} from "../services/storage";
import {
	DEFAULT_SLIPPAGE_BPS,
	MAX_SLIPPAGE_BPS,
	QUOTE_TTL_SECONDS,
	applyFee,
	applySlippage,
	describeRoute,
	quoteBestRoute,
	resolveFeePolicy,
} from "../services/swap";
import {
	buildUniversalRouterSwap,
	permit2Abi,
	type SwapRoute,
} from "../services/uniswap";
import {
	type AccountCall,
	buildSponsoredUserOp,
	encodeExecuteBatch,
	serializeBigInts,
} from "../services/userOp";
import { logError, logInfo, logWarn } from "../services/logger";
import { encodeFunctionData } from "viem";

const swapRoutes = new Hono<AppContext>();

/** Gas budget for a swap UserOp: approvals + router execution. */
const SWAP_CALL_GAS_LIMIT = 700000n;
/** Router deadline and Permit2 expiration window for a prepared swap. */
const EXECUTION_WINDOW_SECONDS = 600;

// GET /swap/tokens - the whitelist the UI may offer. Server is the only
// source of truth so the client can never drift (no hardcoded mirrors).
swapRoutes.get("/tokens", requireAuth, async (c) => {
	const network = getNetworkConfig(c.env.CHAIN_KEY);
	return c.json({
		chainId: network.chainId,
		swapsEnabled: network.uniswap !== null && network.tokens.length >= 2,
		tokens: network.tokens.map((t) => ({
			symbol: t.symbol,
			name: t.name,
			decimals: t.decimals,
			isNative: !!t.isNative,
		})),
	});
});

swapRoutes.post("/quote", requireAuth, async (c) => {
	const requestId = c.get("requestId");
	try {
		const user = c.get("user")!;
		const body = (await c.req.json()) as Record<string, unknown>;

		const network = getNetworkConfig(c.env.CHAIN_KEY);
		if (!network.uniswap) {
			return c.json({ error: "Los cambios no están disponibles en esta red.", error_code: ERR.SWAPS_DISABLED, requestId }, 400);
		}

		// --- Validate inputs strictly against the whitelist ---
		const tokenIn = typeof body.tokenIn === "string" ? getTokenBySymbol(network, body.tokenIn) : null;
		const tokenOut = typeof body.tokenOut === "string" ? getTokenBySymbol(network, body.tokenOut) : null;
		if (!tokenIn || !tokenOut) {
			return c.json({ error: "Token no soportado.", error_code: ERR.UNSUPPORTED_TOKEN, requestId }, 400);
		}
		if (tokenIn.symbol === tokenOut.symbol) {
			return c.json({ error: "Elige dos tokens distintos.", error_code: ERR.SAME_TOKEN, requestId }, 400);
		}

		const amountRawStr = typeof body.amountIn === "string" ? body.amountIn.trim() : "";
		let amountIn: bigint;
		try {
			amountIn = parseUnits(amountRawStr, tokenIn.decimals);
		} catch {
			return c.json({ error: "Monto inválido.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
		}
		if (amountIn <= 0n) {
			return c.json({ error: "El monto debe ser mayor a 0.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
		}

		let slippageBps = DEFAULT_SLIPPAGE_BPS;
		if (body.slippageBps !== undefined) {
			const parsed = Number(body.slippageBps);
			if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SLIPPAGE_BPS) {
				return c.json({ error: "Slippage fuera de rango.", error_code: ERR.SLIPPAGE_OUT_OF_RANGE, requestId }, 400);
			}
			slippageBps = parsed;
		}

		const profile = await getUserByUid(c.env, user.sub);
		const account = profile?.walletAddress as `0x${string}` | undefined;
		if (!account) {
			return c.json({ error: "Necesitas una cuenta para cambiar tokens.", error_code: ERR.NO_WALLET, requestId }, 400);
		}

		// --- Balance check (friendly error before quoting) ---
		const publicClient = getPublicClient(c.env);
		const balance = tokenIn.address
			? ((await publicClient.readContract({
					address: tokenIn.address,
					abi: erc20Abi,
					functionName: "balanceOf",
					args: [account],
				})) as bigint)
			: await publicClient.getBalance({ address: account });
		if (balance < amountIn) {
			return c.json(
				{
					error: `Saldo insuficiente (tienes ${formatUnits(balance, tokenIn.decimals)} ${tokenIn.symbol}).`,
					error_code: ERR.INSUFFICIENT_BALANCE,
					requestId,
				},
				400,
			);
		}

		// --- Find the best route on-chain ---
		const best = await quoteBestRoute(c.env, network, tokenIn, tokenOut, amountIn);
		if (!best) {
			return c.json(
				{ error: "Por ahora no hay una ruta disponible para este par.", error_code: ERR.NO_ROUTE, requestId },
				404,
			);
		}

		const { feeBps } = resolveFeePolicy(c.env);
		const { feeAmount, netAmount } = applyFee(best.amountOut, feeBps);
		const minimumAmountOut = applySlippage(netAmount, slippageBps);

		const quoteId = crypto.randomUUID();
		const now = new Date();
		const expiresAt = new Date(now.getTime() + QUOTE_TTL_SECONDS * 1000);

		await createSwapQuote(c.env, {
			quoteId,
			uid: user.sub,
			chainId: network.chainId,
			tokenIn: tokenIn.symbol,
			tokenOut: tokenOut.symbol,
			amountIn: amountIn.toString(),
			amountOutEstimated: netAmount.toString(),
			minimumAmountOut: minimumAmountOut.toString(),
			feeBps: Number(feeBps),
			feeAmount: feeAmount.toString(),
			protocol: best.route.protocol,
			poolFee: best.route.fee,
			tickSpacing: best.route.tickSpacing,
			slippageBps,
			recipient: account,
			status: "quoted",
			createdAt: now.toISOString(),
			expiresAt: expiresAt.toISOString(),
		});

		logInfo("swap_quote_created", {
			requestId,
			uid: user.sub,
			quoteId,
			pair: `${tokenIn.symbol}->${tokenOut.symbol}`,
			protocol: best.route.protocol,
			poolFee: best.route.fee,
			amountIn: amountRawStr,
		});

		return c.json({
			quoteId,
			chainId: network.chainId,
			tokenIn: tokenIn.symbol,
			tokenOut: tokenOut.symbol,
			amountIn: amountRawStr,
			amountOutEstimated: formatUnits(netAmount, tokenOut.decimals),
			minimumAmountOut: formatUnits(minimumAmountOut, tokenOut.decimals),
			parmeliaFeeBps: Number(feeBps),
			parmeliaFee: formatUnits(feeAmount, tokenOut.decimals),
			gasEstimate: best.gasEstimate.toString(),
			gasSponsored: true,
			route: describeRoute(best.route),
			slippageBps,
			expiresAt: expiresAt.toISOString(),
			warnings: [],
		});
	} catch (error) {
		logError("swap_quote_failed", error, { requestId });
		return c.json({ error: "No pudimos cotizar el cambio. Intenta de nuevo.", error_code: ERR.QUOTE_FAILED, requestId }, 500);
	}
});

swapRoutes.post("/prepare", requireAuth, async (c) => {
	const requestId = c.get("requestId");
	try {
		const user = c.get("user")!;
		const body = (await c.req.json()) as Record<string, unknown>;
		const quoteId = typeof body.quoteId === "string" ? body.quoteId : "";
		if (!quoteId) {
			return c.json({ error: "Falta la cotización.", error_code: ERR.QUOTE_MISSING, requestId }, 400);
		}

		const network = getNetworkConfig(c.env.CHAIN_KEY);
		if (!network.uniswap) {
			return c.json({ error: "Los cambios no están disponibles en esta red.", error_code: ERR.SWAPS_DISABLED, requestId }, 400);
		}

		const quote = await getSwapQuote(c.env, quoteId, user.sub);
		if (!quote) {
			return c.json({ error: "Cotización no encontrada.", error_code: ERR.QUOTE_NOT_FOUND, requestId }, 404);
		}
		if (quote.status !== "quoted") {
			return c.json({ error: "Esta cotización ya fue usada. Cotiza de nuevo.", error_code: ERR.QUOTE_USED, requestId }, 409);
		}
		if (new Date(quote.expiresAt).getTime() <= Date.now()) {
			await updateSwapQuoteStatus(c.env, quoteId, "expired");
			return c.json({ error: "La cotización expiró. Cotiza de nuevo.", error_code: ERR.QUOTE_EXPIRED, requestId }, 409);
		}
		if (quote.chainId !== network.chainId) {
			return c.json({ error: "La cotización es de otra red.", error_code: ERR.QUOTE_WRONG_NETWORK, requestId }, 409);
		}

		// Resolve everything from server-side state - never from the client.
		const tokenIn = getTokenBySymbol(network, quote.tokenIn)!;
		const tokenOut = getTokenBySymbol(network, quote.tokenOut)!;
		const account = quote.recipient as `0x${string}`;
		const profile = await getUserByUid(c.env, user.sub);
		if (!profile?.walletAddress || profile.walletAddress.toLowerCase() !== account.toLowerCase()) {
			logWarn("swap_prepare_recipient_mismatch", { requestId, uid: user.sub, quoteId });
			return c.json({ error: "La cotización no corresponde a tu cuenta.", error_code: ERR.QUOTE_WRONG_ACCOUNT, requestId }, 403);
		}

		const amountIn = BigInt(quote.amountIn);
		const minimumAmountOut = BigInt(quote.minimumAmountOut);
		const route: SwapRoute = {
			protocol: quote.protocol,
			fee: quote.poolFee,
			tickSpacing: quote.tickSpacing,
		};

		// Re-validate the stored route against the pool right before building
		// calldata: if price moved beyond the slippage floor, force a re-quote.
		const fresh = await quoteBestRoute(c.env, network, tokenIn, tokenOut, amountIn);
		const { feeBps, treasury } = resolveFeePolicy(c.env);
		if (!fresh) {
			await updateSwapQuoteStatus(c.env, quoteId, "expired");
			return c.json({ error: "La ruta ya no está disponible. Cotiza de nuevo.", error_code: ERR.NO_ROUTE, requestId }, 409);
		}
		const sameRoute =
			fresh.route.protocol === route.protocol &&
			fresh.route.fee === route.fee &&
			fresh.route.tickSpacing === route.tickSpacing;
		if (!sameRoute || Number(feeBps) !== quote.feeBps) {
			await updateSwapQuoteStatus(c.env, quoteId, "expired");
			return c.json({ error: "La ruta o comisión cambió. Cotiza de nuevo.", error_code: ERR.PRICE_MOVED, requestId }, 409);
		}
		const freshNet = applyFee(fresh.amountOut, feeBps).netAmount;
		if (freshNet < minimumAmountOut) {
			await updateSwapQuoteStatus(c.env, quoteId, "expired");
			return c.json({ error: "El precio cambió. Cotiza de nuevo.", error_code: ERR.PRICE_MOVED, requestId }, 409);
		}

		const deadline = BigInt(Math.floor(Date.now() / 1000) + EXECUTION_WINDOW_SECONDS);
		const { calldata, value } = buildUniversalRouterSwap({
			route,
			tokenIn: tokenIn.address,
			tokenOut: tokenOut.address,
			weth: (tokenIn.wrappedAddress ?? tokenOut.wrappedAddress)!,
			amountIn,
			minAmountOutNet: minimumAmountOut,
			account,
			feeBps,
			treasury,
			deadline,
		});

		// Batch for the smart account. ERC-20 input goes through Permit2 with
		// EXACT-amount allowances that expire with the execution window - a
		// smart account batches approve+swap atomically, so signature-based
		// Permit2 (EIP-712) buys nothing here and would add verifier complexity.
		const calls: AccountCall[] = [];
		if (tokenIn.address) {
			const permit2 = network.uniswap.permit2;
			calls.push({
				target: tokenIn.address,
				value: 0n,
				data: encodeFunctionData({
					abi: erc20Abi,
					functionName: "approve",
					args: [permit2, amountIn],
				}),
			});
			calls.push({
				target: permit2,
				value: 0n,
				data: encodeFunctionData({
					abi: permit2Abi,
					functionName: "approve",
					args: [
						tokenIn.address,
						network.uniswap.universalRouter,
						amountIn,
						Number(deadline),
					],
				}),
			});
		}
		calls.push({
			target: network.uniswap.universalRouter,
			value,
			data: calldata as Hex,
		});

		const executeCalldata = encodeExecuteBatch(calls);
		const { userOp, userOpHash } = await buildSponsoredUserOp(c.env, {
			sender: account,
			callData: executeCalldata,
			callGasLimit: SWAP_CALL_GAS_LIMIT,
		});

		await createPendingPayment(c.env, {
			userOpHash,
			linkId: null,
			uid: user.sub,
			amount: formatUnits(amountIn, tokenIn.decimals),
			currency: "SWAP",
			wallet: account,
			senderAddress: account,
			userOp: serializeBigInts(userOp) as Record<string, unknown>,
			// Context for /pay/submit to write precise ledger entries.
			meta: {
				quoteId,
				tokenIn: tokenIn.symbol,
				tokenOut: tokenOut.symbol,
				amountIn: formatUnits(amountIn, tokenIn.decimals),
				amountOutEstimated: formatUnits(BigInt(quote.amountOutEstimated), tokenOut.decimals),
			},
		});
		await updateSwapQuoteStatus(c.env, quoteId, "prepared");

		logInfo("swap_prepare_created", {
			requestId,
			uid: user.sub,
			quoteId,
			userOpHash,
			pair: `${quote.tokenIn}->${quote.tokenOut}`,
			protocol: quote.protocol,
		});

		return c.json({
			userOpHash,
			credentialId: profile.credentialId ?? null,
			summary: {
				tokenIn: quote.tokenIn,
				tokenOut: quote.tokenOut,
				amountIn: formatUnits(amountIn, tokenIn.decimals),
				minimumAmountOut: formatUnits(minimumAmountOut, tokenOut.decimals),
				route: describeRoute(route),
				validUntil: new Date(Number(deadline) * 1000).toISOString(),
			},
		});
	} catch (error) {
		logError("swap_prepare_failed", error, { requestId });
		return c.json({ error: "No pudimos preparar el cambio. Intenta de nuevo.", error_code: ERR.SWAP_PREPARE_FAILED, requestId }, 500);
	}
});

export default swapRoutes;

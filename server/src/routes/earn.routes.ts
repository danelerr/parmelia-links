// Earn (Modo Ahorro): Aave v3 USDC supply. Design: DEFI_DESIGN.md v2.0.
//
//   GET  /earn/config  → enabled/canDeposit/canWithdraw + live APY + balances
//   POST /earn/prepare → builds the sponsored UserOp (deposit or withdraw);
//                        the client signs it and submits via /pay/submit,
//                        which settles it through the standard lifecycle
//                        (currency EARN_DEPOSIT / EARN_WITHDRAW → ledger 'earn').
//
// Everything is validated and encoded server-side; the client only sends an
// action + amount. Amounts are the user's own funds moving between their
// available balance and their aToken position (zero custody).

import { Hono } from "hono";
import { formatUnits, parseUnits } from "viem";
import { erc20Abi, getNetworkConfig, ERR } from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import { getPublicClient } from "../services/clients";
import {
	buildDepositCalls,
	buildWithdrawCalls,
	getEarnStatus,
	getSavingsBalance,
	isEarnConfigured,
} from "../services/earn";
import { createPendingPayment, getUserByUid } from "../services/storage";
import { buildSponsoredUserOp, encodeExecuteBatch, serializeBigInts } from "../services/userOp";
import { logError, logInfo } from "../services/logger";
import { selectUserOperationTransport } from "../services/userOperationTransport";

const earnRoutes = new Hono<AppContext>();

/** Aave supply ≈ 250-330k gas (+approve); withdraw ≈ 300-400k. Cap, not spend. */
const EARN_CALL_GAS_LIMIT = 600000n;

earnRoutes.get("/config", requireAuth, async (c) => {
	const user = c.get("user")!;
	const network = getNetworkConfig(c.env.CHAIN_KEY);
	const status = await getEarnStatus(c.env).catch(() => ({
		enabled: false,
		canDeposit: false,
		canWithdraw: false,
		apyPercent: 0,
	}));

	let savings = "0";
	let available = "0";
	const profile = await getUserByUid(c.env, user.sub);
	if (profile?.walletAddress && network.aave) {
		const account = profile.walletAddress as `0x${string}`;
		try {
			const publicClient = getPublicClient(c.env);
			const [availableRaw, savingsValue] = await Promise.all([
				publicClient.readContract({
					address: network.contracts.usdc,
					abi: erc20Abi,
					functionName: "balanceOf",
					args: [account],
				}) as Promise<bigint>,
				getSavingsBalance(c.env, account),
			]);
			available = formatUnits(availableRaw, network.contracts.usdcDecimals);
			savings = savingsValue;
		} catch {
			/* balances stay "0"; the UI shows the error state on prepare */
		}
	}

	return c.json({
		enabled: status.enabled,
		canDeposit: status.canDeposit,
		canWithdraw: status.canWithdraw,
		apyPercent: Number(status.apyPercent.toFixed(2)),
		token: "USDC",
		savings,
		available,
	});
});

earnRoutes.post("/prepare", requireAuth, async (c) => {
	const requestId = c.get("requestId");
	try {
		const user = c.get("user")!;
		const network = getNetworkConfig(c.env.CHAIN_KEY);
		if (!isEarnConfigured(c.env)) {
			return c.json({ error: "El ahorro no está disponible en esta red.", error_code: ERR.EARN_DISABLED, requestId }, 400);
		}

		const body = (await c.req.json()) as Record<string, unknown>;
		const action = body.action === "withdraw" ? "withdraw" : body.action === "deposit" ? "deposit" : null;
		if (!action) {
			return c.json({ error: "Acción inválida.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
		}

		// Live reserve state, fail-closed per direction (frozen still withdraws).
		const status = await getEarnStatus(c.env);
		if ((action === "deposit" && !status.canDeposit) || (action === "withdraw" && !status.canWithdraw)) {
			return c.json({ error: "El ahorro no está disponible ahora. Intenta más tarde.", error_code: ERR.EARN_DISABLED, requestId }, 400);
		}

		const profile = await getUserByUid(c.env, user.sub);
		const account = profile?.walletAddress as `0x${string}` | undefined;
		if (!account) {
			return c.json({ error: "Necesitas una cuenta primero.", error_code: ERR.NO_WALLET, requestId }, 400);
		}

		const decimals = network.contracts.usdcDecimals;
		const withdrawAll = action === "withdraw" && body.amount === "max";

		let amountRaw: bigint | null = null;
		if (!withdrawAll) {
			try {
				amountRaw = parseUnits(typeof body.amount === "string" ? body.amount.trim() : "", decimals);
			} catch {
				return c.json({ error: "Monto inválido.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
			}
			if (amountRaw <= 0n) {
				return c.json({ error: "El monto debe ser mayor a 0.", error_code: ERR.INVALID_AMOUNT, requestId }, 400);
			}
		}

		const publicClient = getPublicClient(c.env);
		let ledgerAmount: string; // human string recorded at settlement
		if (action === "deposit") {
			const balance = (await publicClient.readContract({
				address: network.contracts.usdc,
				abi: erc20Abi,
				functionName: "balanceOf",
				args: [account],
			})) as bigint;
			if (balance < amountRaw!) {
				return c.json(
					{
						error: `Saldo insuficiente (tienes ${formatUnits(balance, decimals)} USDC disponibles).`,
						error_code: ERR.INSUFFICIENT_BALANCE,
						requestId,
					},
					400,
				);
			}
			ledgerAmount = formatUnits(amountRaw!, decimals);
		} else {
			const saved = (await publicClient.readContract({
				address: network.aave!.aUsdc,
				abi: erc20Abi,
				functionName: "balanceOf",
				args: [account],
			})) as bigint;
			if (saved <= 0n || (!withdrawAll && saved < amountRaw!)) {
				return c.json(
					{
						error: `Ahorro insuficiente (tienes ${formatUnits(saved, decimals)} USDC ahorrados).`,
						error_code: ERR.INSUFFICIENT_BALANCE,
						requestId,
					},
					400,
				);
			}
			// For "max" the exact on-chain amount includes accrual up to execution;
			// the balance at prepare is the closest honest figure for the statement.
			ledgerAmount = formatUnits(withdrawAll ? saved : amountRaw!, decimals);
		}

		const calls =
			action === "deposit"
				? buildDepositCalls(network, account, amountRaw!)
				: buildWithdrawCalls(network, account, withdrawAll ? null : amountRaw);
		const submissionTransport = selectUserOperationTransport(c.env, user.sub);
		const { userOp, userOpHash } = await buildSponsoredUserOp(c.env, {
			sender: account,
			callData: encodeExecuteBatch(calls),
			callGasLimit: EARN_CALL_GAS_LIMIT,
			transportMode: submissionTransport,
		});

		await createPendingPayment(c.env, {
			userOpHash,
			linkId: null,
			uid: user.sub,
			amount: ledgerAmount,
			currency: action === "deposit" ? "EARN_DEPOSIT" : "EARN_WITHDRAW",
			wallet: account,
			senderAddress: account,
			userOp: serializeBigInts(userOp) as Record<string, unknown>,
			meta: { action, pool: network.aave!.pool, withdrawAll },
			submissionTransport,
		});

		logInfo("earn_prepare_created", { requestId, uid: user.sub, userOpHash, action, amount: ledgerAmount });
		return c.json({
			userOpHash,
			credentialId: profile?.credentialId ?? null,
			submissionTransport,
			summary: { action, amount: ledgerAmount, apyPercent: status.apyPercent },
		});
	} catch (error) {
		logError("earn_prepare_failed", error, { requestId });
		return c.json({ error: "No pudimos preparar la operación. Intenta de nuevo.", error_code: ERR.SERVER_ERROR, requestId }, 500);
	}
});

export default earnRoutes;

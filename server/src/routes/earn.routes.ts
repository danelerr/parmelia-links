// Earn (Modo Ahorro): Aave v3 USDC supply. Design: docs/design/defi.md v2.0.
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
	isWithdrawAllRequest,
	isEarnConfigured,
} from "../services/earn";
import { createPendingPayment, getUserByUid } from "../services/storage";
import { buildSponsoredUserOp, encodeExecuteBatch, serializeBigInts } from "../services/userOp";
import { logError, logInfo } from "../services/logger";
import { selectUserOperationTransport } from "../services/userOperationTransport";
import { readBalanceModel } from "../services/homeReadModel";

const earnRoutes = new Hono<AppContext>();

/** Aave supply ≈ 250-330k gas (+approve); withdraw ≈ 300-400k. Cap, not spend. */
const EARN_CALL_GAS_LIMIT = 600000n;

earnRoutes.get("/config", requireAuth, async (c) => {
	const user = c.get("user")!;
	const network = getNetworkConfig(c.env.CHAIN_KEY);
	const initialModelPromise = readBalanceModel(c.env, user.sub);
	const liveBalancesPromise = c.req.query("fresh") === "1"
		? initialModelPromise.then(async (model) => {
			if (!model.walletAddress || !network.aave) return null;
			try {
				const publicClient = getPublicClient(c.env);
				const [availableRaw, savingsRaw] = await publicClient.multicall({
					allowFailure: false,
					contracts: [
						{
							address: network.contracts.usdc,
							abi: erc20Abi,
							functionName: "balanceOf",
							args: [model.walletAddress],
						},
						{
							address: network.aave.aUsdc,
							abi: erc20Abi,
							functionName: "balanceOf",
							args: [model.walletAddress],
						},
					],
				});
				return {
					available: formatUnits(availableRaw, network.contracts.usdcDecimals),
					savings: formatUnits(savingsRaw, network.contracts.usdcDecimals),
				};
			} catch (error) {
				// This endpoint is an interactive view, not an accounting write. Keep
				// the block-evidenced read model when the single multicall is unavailable.
				logError("earn_interactive_balance_refresh_failed", error, {
					uid: user.sub,
				});
				return null;
			}
		})
		: Promise.resolve(null);

	const [status, initialModel, tracked, liveBalances] = await Promise.all([
		getEarnStatus(c.env).catch(() => ({
			enabled: false,
			canDeposit: false,
			canWithdraw: false,
			apyPercent: 0,
		})),
		initialModelPromise,
		c.env.GATOPAGO_DB.prepare(
			`SELECT
			   COALESCE(SUM(CASE WHEN direction = 'out' THEN CAST(amount AS REAL) ELSE 0 END), 0) AS deposits,
			   COALESCE(SUM(CASE WHEN direction = 'in' THEN CAST(amount AS REAL) ELSE 0 END), 0) AS withdrawals
			 FROM ledger WHERE uid = ? AND kind = 'earn' AND canonical = 1`,
		).bind(user.sub).first<{ deposits: number; withdrawals: number }>(),
		liveBalancesPromise,
	]);

	const savings = liveBalances?.savings ?? initialModel.balance.savings;
	const available = liveBalances?.available ?? initialModel.balance.tokens.USDC ?? null;
	const balanceStatus = liveBalances ? "fresh" : initialModel.balance.status;

	const estimatedEarnings = savings === null
		? null
		: Math.max(0, Number(savings) + Number(tracked?.withdrawals ?? 0) - Number(tracked?.deposits ?? 0)).toFixed(6);
	return c.json({
		enabled: status.enabled,
		canDeposit: status.canDeposit,
		canWithdraw: status.canWithdraw,
		apyPercent: Number(status.apyPercent.toFixed(2)),
		token: "USDC",
		savings,
		available,
		balanceStatus,
		estimatedEarnings,
		protocol: "Aave V3",
		networkName: network.name,
		poolAddress: network.aave?.pool ?? null,
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
		const withdrawAll = isWithdrawAllRequest(action, body.amount, body.withdrawAll);

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
		const { userOp, userOpHash, rpId, signingPayload, sponsorshipProvider,
			sponsorshipPaymasterAddress } = await buildSponsoredUserOp(c.env, {
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
			sponsorshipProvider,
			sponsorshipPaymasterAddress,
		});

		logInfo("earn_prepare_created", { requestId, uid: user.sub, userOpHash, action, amount: ledgerAmount });
		return c.json({
			userOpHash,
			credentialId: profile?.credentialId ?? null,
			rpId,
			submissionTransport,
			signingPayload,
			summary: { action, amount: ledgerAmount, apyPercent: status.apyPercent, withdrawAll },
		});
	} catch (error) {
		logError("earn_prepare_failed", error, { requestId });
		return c.json({ error: "No pudimos preparar la operación. Intenta de nuevo.", error_code: ERR.SERVER_ERROR, requestId }, 500);
	}
});

export default earnRoutes;

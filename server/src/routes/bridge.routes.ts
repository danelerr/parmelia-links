// Cross-chain deposits/withdrawals (Módulo 1 MVP): quotes + supported chains.
// Execution: deposits via Across UI prefilled with the user's smart account;
// withdrawal execution from the smart account is the documented next step.

import { Hono } from "hono";
import { getNetworkConfig, ERR } from "../../../shared";
import { AppContext, requireAuth } from "../middlewares/auth";
import { getUserByUid } from "../services/storage";
import {
	ARBITRUM_ONE_CHAIN_ID,
	BRIDGE_CHAINS,
	BridgeError,
	quoteBridge,
} from "../services/bridge";
import { logError } from "../services/logger";

const bridgeRoutes = new Hono<AppContext>();

bridgeRoutes.get("/config", requireAuth, async (c) => {
	const network = getNetworkConfig(c.env.CHAIN_KEY);
	// Cross-chain only makes sense against Arbitrum One (real liquidity/routes).
	const enabled = network.chainId === ARBITRUM_ONE_CHAIN_ID;
	return c.json({
		enabled,
		token: "USDC",
		chains: BRIDGE_CHAINS.map((chain) => ({ id: chain.id, key: chain.key, name: chain.name })),
	});
});

bridgeRoutes.post("/quote", requireAuth, async (c) => {
	const requestId = c.get("requestId");
	try {
		const user = c.get("user")!;
		const body = (await c.req.json()) as Record<string, unknown>;

		const network = getNetworkConfig(c.env.CHAIN_KEY);
		if (network.chainId !== ARBITRUM_ONE_CHAIN_ID) {
			return c.json(
				{ error: "Mover entre redes estará disponible en mainnet.", error_code: ERR.BRIDGE_DISABLED, requestId },
				400,
			);
		}

		const direction = body.direction === "withdraw" ? "withdraw" : "deposit";
		const externalChainId = Number(body.chainId);
		const amount = typeof body.amount === "string" ? body.amount.trim() : "";

		const profile = await getUserByUid(c.env, user.sub);
		const account = profile?.walletAddress as `0x${string}` | undefined;
		if (!account) {
			return c.json({ error: "Necesitas una cuenta primero.", error_code: ERR.NO_WALLET, requestId }, 400);
		}

		const crosschainFeeBps = BigInt(c.env.PARMELIA_CROSSCHAIN_FEE_BPS || "0");
		const quote = await quoteBridge({
			direction,
			externalChainId,
			amount,
			arbitrumUsdc: network.contracts.usdc,
			recipient: account,
			crosschainFeeBps: crosschainFeeBps > 100n ? 100n : crosschainFeeBps,
		});

		return c.json({ ...quote, requestId });
	} catch (error) {
		if (error instanceof BridgeError) {
			return c.json({ error: error.message, error_code: ERR.BRIDGE_INVALID_REQUEST, requestId }, 400);
		}
		logError("bridge_quote_failed", error, { requestId });
		return c.json({ error: "No pudimos cotizar el puente. Intenta de nuevo.", error_code: ERR.BRIDGE_QUOTE_FAILED, requestId }, 500);
	}
});

export default bridgeRoutes;

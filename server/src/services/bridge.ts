// Cross-chain quotes (Módulo 1 MVP) via the public Across API — no API key.
//
// Scope by design:
//   - USDC only (the core LatAm asset; deepest Across support).
//   - Deposits: quote here, execution happens on Across's own UI prefilled with
//     the user's smart account as recipient → funds land directly in Parmelia,
//     we never custody anything and there is no new fund-moving code to audit.
//   - Withdrawals: quoted (origin = Arbitrum); execution from the smart account
//     (SpokePool depositV3 batched like a swap) is the documented next step —
//     it needs the verified SpokePool ABI/address + a testnet smoke test.

import { formatUnits, parseUnits } from "viem";

const ACROSS_API_BASE = "https://app.across.to/api";
const USDC_DECIMALS = 6;

/**
 * Origin/destination chains offered in the UI. USDC addresses from Circle's
 * official list — TODO: re-verify against developers.circle.com before
 * enabling on mainnet traffic.
 */
export const BRIDGE_CHAINS = [
	{ id: 1, key: "ethereum", name: "Ethereum", usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
	{ id: 8453, key: "base", name: "Base", usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
	{ id: 10, key: "optimism", name: "Optimism", usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" },
] as const;

export const ARBITRUM_ONE_CHAIN_ID = 42161;

export type BridgeDirection = "deposit" | "withdraw";

export type BridgeQuote = {
	direction: BridgeDirection;
	originChainId: number;
	destinationChainId: number;
	token: "USDC";
	amountIn: string;
	bridgeFee: string;
	parmeliaFee: string;
	amountOutEstimated: string;
	estimatedMinutes: number;
	/** Across UI prefilled with the recipient (deposits only). */
	acrossUrl: string | null;
	warnings: string[];
};

type AcrossSuggestedFees = {
	totalRelayFee?: { total?: string };
	estimatedFillTimeSec?: number;
	isAmountTooLow?: boolean;
};

export function getBridgeChain(chainId: number) {
	return BRIDGE_CHAINS.find((chain) => chain.id === chainId) ?? null;
}

export async function quoteBridge(params: {
	direction: BridgeDirection;
	externalChainId: number;
	amount: string;
	arbitrumUsdc: `0x${string}`;
	recipient: `0x${string}`;
	crosschainFeeBps: bigint;
}): Promise<BridgeQuote> {
	const external = getBridgeChain(params.externalChainId);
	if (!external) throw new BridgeError("Red no soportada.");

	let amountRaw: bigint;
	try {
		amountRaw = parseUnits(params.amount, USDC_DECIMALS);
	} catch {
		throw new BridgeError("Monto inválido.");
	}
	if (amountRaw <= 0n) throw new BridgeError("El monto debe ser mayor a 0.");

	const isDeposit = params.direction === "deposit";
	const originChainId = isDeposit ? external.id : ARBITRUM_ONE_CHAIN_ID;
	const destinationChainId = isDeposit ? ARBITRUM_ONE_CHAIN_ID : external.id;
	const inputToken = isDeposit ? external.usdc : params.arbitrumUsdc;
	const outputToken = isDeposit ? params.arbitrumUsdc : external.usdc;

	const url =
		`${ACROSS_API_BASE}/suggested-fees` +
		`?inputToken=${inputToken}&outputToken=${outputToken}` +
		`&originChainId=${originChainId}&destinationChainId=${destinationChainId}` +
		`&amount=${amountRaw.toString()}&recipient=${params.recipient}`;

	const res = await fetch(url);
	if (!res.ok) {
		throw new BridgeError("La cotización del puente no está disponible ahora. Intenta de nuevo.");
	}
	const data = (await res.json()) as AcrossSuggestedFees;
	if (data.isAmountTooLow) {
		throw new BridgeError("El monto es muy bajo para moverlo entre redes.");
	}

	const bridgeFeeRaw = BigInt(data.totalRelayFee?.total ?? "0");
	// Service spread only applies to withdrawals (we build that tx); deposits go
	// straight to the user's account through Across, so they are free on our side.
	const parmeliaFeeRaw = isDeposit ? 0n : (amountRaw * params.crosschainFeeBps) / 10_000n;
	const outRaw = amountRaw - bridgeFeeRaw - parmeliaFeeRaw;
	if (outRaw <= 0n) throw new BridgeError("El monto no cubre el costo del puente.");

	const acrossUrl = isDeposit
		? `https://app.across.to/bridge?fromChain=${originChainId}&toChain=${destinationChainId}` +
			`&inputToken=${inputToken}&outputToken=${outputToken}&recipient=${params.recipient}`
		: null;

	return {
		direction: params.direction,
		originChainId,
		destinationChainId,
		token: "USDC",
		amountIn: params.amount,
		bridgeFee: formatUnits(bridgeFeeRaw, USDC_DECIMALS),
		parmeliaFee: formatUnits(parmeliaFeeRaw, USDC_DECIMALS),
		amountOutEstimated: formatUnits(outRaw, USDC_DECIMALS),
		estimatedMinutes: Math.max(1, Math.ceil((data.estimatedFillTimeSec ?? 120) / 60)),
		acrossUrl,
		warnings: [],
	};
}

export class BridgeError extends Error {}

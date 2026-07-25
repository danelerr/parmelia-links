export * from "./EntryPointAbi";
export * from "./networks";
export * from "./errors";

// Contract addresses live per-chain in ./networks (NETWORKS[key].contracts) so the
// app stays portable. Resolve them at runtime with getNetworkConfig(CHAIN_KEY).

// ============================================================
// ABIs (chain-independent - compiled from contracts/out)
// ============================================================

export { abi as accountWebAuthnV2Abi } from "../contracts/out/AccountWebAuthnV2.sol/AccountWebAuthnV2.json";
export { abi as accountFactoryV2Abi } from "../contracts/out/AccountFactoryV2.sol/AccountFactoryV2.json";
export { abi as paymentRouterAbi } from "../contracts/out/ParmeliaPaymentRouter.sol/ParmeliaPaymentRouter.json";
export { abi as crosschainRouterAbi } from "../contracts/out/ParmeliaCrosschainRouter.sol/ParmeliaCrosschainRouter.json";

export const erc20Abi = [
	{
		inputs: [{ name: "account", type: "address" }],
		name: "balanceOf",
		outputs: [{ name: "", type: "uint256" }],
		stateMutability: "view",
		type: "function",
	},
	{
		inputs: [
			{ name: "to", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		name: "transfer",
		outputs: [{ name: "", type: "bool" }],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [
			{ name: "spender", type: "address" },
			{ name: "amount", type: "uint256" },
		],
		name: "approve",
		outputs: [{ name: "", type: "bool" }],
		stateMutability: "nonpayable",
		type: "function",
	},
	{
		inputs: [],
		name: "decimals",
		outputs: [{ name: "", type: "uint8" }],
		stateMutability: "view",
		type: "function",
	},
] as const;

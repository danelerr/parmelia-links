export * from "./EntryPointAbi";
// Base Sepolia (chain 84532) — deployed 2026-03-08
export const FACTORY_ADDRESS = "0x8c91e55b11287c9c3970b64602fe50763fac0345";
export const ENTRYPOINT_ADDRESS = "0x433709009B8330FDa32311DF1C2AFA402eD8D009";
export const PAYMASTER_ADDRESS = "0xa1DC7ad6f4d2d0ea20bF5668F132c38c4f3c172D";
// USDC on Base Sepolia
export const USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
export const USDC_DECIMALS = 6;

export { abi as accountWebAuthnAbi } from "../contracts/out/AccountWebAuthn.sol/AccountWebAuthn.json";
export { abi as accountFactoryAbi } from "../contracts/out/AccountFactory.sol/AccountFactory.json";

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
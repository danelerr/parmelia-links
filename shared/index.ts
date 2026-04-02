export * from "./EntryPointAbi";
export * from "./networks";

// ============================================================
// V2 Contract Addresses (Monad Testnet)
// ============================================================

export const VERIFIER_ADDRESS = "0x900Cd8B955d88fD7b805eDcA939f0BFB069946bd";
export const ACCOUNT_IMPLEMENTATION_ADDRESS = "0x536eD5b326d148fB0097b1f29F0Cb45862b91DC7";
export const FACTORY_ADDRESS = "0x91Bf4c06D2A588980450Bb6AEDc43f1923f149c2";
export const ENTRYPOINT_ADDRESS = "0x433709009B8330FDa32311DF1C2AFA402eD8D009";
export const PAYMASTER_ADDRESS = "0xbcC45e484a1D448b3Df629aD91B0Cc6A7a7463b2";

// USDC remains configurable separately until the Monad token address is confirmed.
export const USDC_ADDRESS = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
export const USDC_DECIMALS = 6;

// ============================================================
// V2 ABIs (from compiled artifacts)
// ============================================================

export { abi as accountWebAuthnV2Abi } from "../contracts/out/AccountWebAuthnV2.sol/AccountWebAuthnV2.json";
export { abi as accountFactoryV2Abi } from "../contracts/out/AccountFactoryV2.sol/AccountFactoryV2.json";

// Legacy V1 ABIs (keep for reference during migration)
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

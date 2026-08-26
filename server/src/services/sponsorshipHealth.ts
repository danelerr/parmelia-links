import { getAddress, parseAbi, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getNetworkConfig } from "../../../shared";
import type { Bindings } from "../middlewares/auth";
import { getPublicClient } from "./clients";
import { getPaymasterSignerKey } from "./keys";
import { sponsorshipProviderNames } from "./sponsorship";

const paymasterHealthAbi = parseAbi([
	"function ENTRY_POINT() view returns (address)",
	"function sponsorSigner() view returns (address)",
	"function getDeposit() view returns (uint256)",
	"function maxSponsoredGasCost() view returns (uint256)",
]);

export type SponsorshipHealth = {
	status: "disabled" | "ok" | "error";
	providers: string[];
	paymasterAddress: Address | null;
	depositWei: string | null;
	maxSponsoredGasCostWei: string | null;
	activeOperationsByProvider: Record<string, number>;
	activeOperations: Array<{ provider: string; paymasterAddress: string | null; count: number }>;
	issues: string[];
};

export async function collectSponsorshipHealth(env: Bindings): Promise<SponsorshipHealth> {
	const providers = sponsorshipProviderNames(env);
	const activeRows = await env.GATOPAGO_DB.prepare(
		`SELECT sponsorship_provider, sponsorship_paymaster_address, COUNT(*) AS count
		 FROM pending_payments
		 WHERE status IN ('prepared', 'submitting', 'submitted')
		 GROUP BY sponsorship_provider, sponsorship_paymaster_address`,
	).all<{ sponsorship_provider: string; sponsorship_paymaster_address: string | null; count: number }>();
	const activeOperationsByProvider: Record<string, number> = {};
	for (const row of activeRows.results) {
		activeOperationsByProvider[row.sponsorship_provider] =
			(activeOperationsByProvider[row.sponsorship_provider] ?? 0) + row.count;
	}
	const activeOperations = activeRows.results.map((row) => ({ provider: row.sponsorship_provider,
		paymasterAddress: row.sponsorship_paymaster_address, count: row.count }));
	if (env.SPONSORSHIP_HEALTH_CHECK_ENABLED !== "true") {
		return { status: "disabled", providers, paymasterAddress: null, depositWei: null,
			maxSponsoredGasCostWei: null, activeOperationsByProvider, activeOperations, issues: [] };
	}
	if (!providers.includes("parmelia")) {
		return { status: "ok", providers, paymasterAddress: null, depositWei: null,
			maxSponsoredGasCostWei: null, activeOperationsByProvider, activeOperations, issues: [] };
	}
	const network = getNetworkConfig(env.CHAIN_KEY);
	const paymaster = getAddress(env.SPONSORSHIP_PAYMASTER_ADDRESS?.trim() ||
		network.contracts.paymaster);
	const client = getPublicClient(env);
	const [code, entryPoint, sponsorSigner, deposit, maxSponsoredGasCost] = await Promise.all([
		client.getCode({ address: paymaster }),
		client.readContract({ address: paymaster, abi: paymasterHealthAbi, functionName: "ENTRY_POINT" }),
		client.readContract({ address: paymaster, abi: paymasterHealthAbi, functionName: "sponsorSigner" }),
		client.readContract({ address: paymaster, abi: paymasterHealthAbi, functionName: "getDeposit" }),
		client.readContract({ address: paymaster, abi: paymasterHealthAbi, functionName: "maxSponsoredGasCost" }),
	]);
	const issues: string[] = [];
	if (!code || code === "0x") issues.push("paymaster_code_missing");
	if (getAddress(entryPoint) !== getAddress(network.contracts.entryPoint)) {
		issues.push("paymaster_entrypoint_mismatch");
	}
	const expectedSigner = privateKeyToAccount(getPaymasterSignerKey(env)).address;
	if (getAddress(sponsorSigner) !== getAddress(expectedSigner)) {
		issues.push("paymaster_signer_mismatch");
	}
	const minimum = BigInt(env.PAYMASTER_MIN_DEPOSIT_WEI ?? "0");
	if (deposit < minimum) issues.push("paymaster_deposit_low");
	return { status: issues.length === 0 ? "ok" : "error", providers,
		paymasterAddress: paymaster, depositWei: deposit.toString(),
		maxSponsoredGasCostWei: maxSponsoredGasCost.toString(), activeOperationsByProvider,
		activeOperations, issues };
}

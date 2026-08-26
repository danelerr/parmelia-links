import { describe, expect, it } from "vitest";
import { __test } from "../src/index";
import type { Bindings } from "../src/env";

const env = { SETTLEMENT_CHAIN_ID: "421614" } as Bindings;
const claim = { service: "gatopago-app-api" as const, requestId: "req-1", uid: "user-1" };

describe("Payments RPC N/N-1 compatibility", () => {
	it("normalizes v1 settlement commands", () => {
		const normalized = __test.normalizeSettlementCommand({ contractVersion: 1, claim,
			accountVersion: 3, walletAddress: "0x0000000000000000000000000000000000000001" }, env);
		expect(normalized).toMatchObject({ contractVersion: 2, chainId: 421614, accountVersion: 3 });
	});

	it("keeps v2 reserve commands unchanged and rejects future versions", () => {
		const current = { contractVersion: 2 as const, commandId: "cmd-1", claim, linkId: "link-1",
			payerAddress: "0x0000000000000000000000000000000000000001", sourceChainId: 421614 as const,
			requestedRoute: "local" as const };
		expect(__test.normalizeReserveCommand(current, env)).toEqual(current);
		expect(__test.normalizeReserveCommand({ ...current, contractVersion: 3 } as never, env)).toBeNull();
	});
});

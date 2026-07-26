import { describe, expect, it } from "vitest";
import {
	laneForRole,
	providerAliasForUrl,
	__test,
} from "../src/services/rpcControlPlane";

describe("RPC control plane", () => {
	it("uses safe aliases and never exposes an API-key URL", () => {
		const secretUrl =
			"https://arb-sepolia.g.alchemy.com/v2/this-key-must-not-appear";
		expect(providerAliasForUrl(secretUrl, "read", 0)).toBe("alchemy");
		expect(providerAliasForUrl(secretUrl, "read", 0)).not.toContain(
			"this-key-must-not-appear",
		);
		expect(
			providerAliasForUrl(
				"https://sepolia-rollup.arbitrum.io/rpc",
				"indexer",
				0,
			),
		).toBe("arbitrum-public-sepolia");
		expect(providerAliasForUrl("https://rpc.example/private", "read", 1)).toBe(
			"read-endpoint-2",
		);
	});

	it("assigns workload isolation lanes by role", () => {
		expect(laneForRole("write")).toBe("critical-write");
		expect(laneForRole("indexer")).toBe("canonical-ingest");
		expect(laneForRole("read")).toBe("active-reconcile");
		expect(laneForRole("archive")).toBe("backfill");
	});

	it("classifies RPC methods for cost attribution", () => {
		expect(__test.rpcMethodFamily("eth_getLogs")).toBe("logs");
		expect(__test.rpcMethodFamily("eth_call")).toBe("contract_read");
		expect(__test.rpcMethodFamily("eth_getTransactionReceipt")).toBe(
			"receipt",
		);
		expect(__test.rpcMethodFamily("eth_sendUserOperation")).toBe(
			"broadcast",
		);
	});

	it("classifies transient failures without persisting raw errors", () => {
		expect(__test.failureCode(new Error("HTTP 429 rate limit"))).toBe(
			"RATE_LIMITED",
		);
		expect(__test.failureCode(new Error("request timed out"))).toBe("TIMEOUT");
		expect(__test.failureCode(new Error("fetch failed"))).toBe("NETWORK");
		expect(__test.failureThreshold("RATE_LIMITED")).toBe(1);
		expect(__test.failureThreshold("TIMEOUT")).toBe(3);
		expect(__test.circuitOpenMs("RATE_LIMITED")).toBeLessThan(
			__test.circuitOpenMs("TIMEOUT"),
		);
	});

	it("sheds backfill before critical lanes wait", () => {
		expect(__test.admissionWaitMs("backfill", 10_000)).toBe(250);
		expect(__test.admissionWaitMs("critical-write", 10_000)).toBe(2_000);
		expect(__test.admissionWaitMs("active-reconcile", 10_000)).toBe(1_000);
	});

	it("hands a saturated lane directly to the oldest waiter", async () => {
		const semaphore = new __test.LocalSemaphore(1);
		const releaseFirst = await semaphore.acquire(1_000);
		const second = semaphore.acquire(1_000);
		releaseFirst();
		const third = semaphore.acquire(1_000);
		const releaseSecond = await second;
		let thirdAdmitted = false;
		const thirdObserver = third.then(() => {
			thirdAdmitted = true;
		});
		await Promise.resolve();
		expect(thirdAdmitted).toBe(false);
		releaseSecond();
		const releaseThird = await third;
		await thirdObserver;
		expect(thirdAdmitted).toBe(true);
		releaseThird();
	});
});

import { describe, expect, it } from "vitest";
import { __test } from "../src/services/homeReadModel";

describe("Home read model refresh policy", () => {
	it("does not mistake an existing stale snapshot for missing bootstrap data", () => {
		expect(__test.needsBalanceBootstrap(true, 3, 3)).toBe(false);
		expect(__test.needsBalanceBootstrap(true, 4, 3)).toBe(false);
	});

	it("bootstraps only missing wallet assets", () => {
		expect(__test.needsBalanceBootstrap(true, 0, 3)).toBe(true);
		expect(__test.needsBalanceBootstrap(true, 2, 3)).toBe(true);
		expect(__test.needsBalanceBootstrap(false, 0, 3)).toBe(false);
	});
});

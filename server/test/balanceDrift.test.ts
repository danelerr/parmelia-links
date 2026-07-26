import { describe, expect, it } from "vitest";
import { __test } from "../src/services/balanceDrift";

describe("balance projection drift", () => {
	it("compares signed raw deltas by absolute magnitude", () => {
		expect(__test.absolute(0n)).toBe(0n);
		expect(__test.absolute(25n)).toBe(25n);
		expect(__test.absolute(-25n)).toBe(25n);
	});
});

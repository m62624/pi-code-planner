import { describe, expect, it } from "vitest";
import { isPathInsideOrEqual } from "./path-utils";

describe("isPathInsideOrEqual", () => {
	it("treats a path equal to the root as inside", () => {
		expect(isPathInsideOrEqual("/repo", "/repo")).toBe(true);
	});

	it("accepts a nested path", () => {
		expect(isPathInsideOrEqual("/repo/src/index.ts", "/repo")).toBe(true);
	});

	it("rejects a sibling that shares a prefix", () => {
		expect(isPathInsideOrEqual("/repo-other/file", "/repo")).toBe(false);
	});

	it("rejects a parent-escape path", () => {
		expect(isPathInsideOrEqual("/repo/../secret", "/repo")).toBe(false);
	});

	it("normalizes relative segments before comparing", () => {
		expect(isPathInsideOrEqual("/repo/src/../src/a.ts", "/repo")).toBe(true);
	});
});

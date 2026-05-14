import { describe, expect, it } from "vitest";
import {
	createAttemptId,
	createPlanId,
	createProjectKey,
	createWorkItemId,
	sanitizeId,
	shortHash,
} from "./ids";

describe("storage ids", () => {
	it("sanitizes ids for filesystem and branch-safe names", () => {
		expect(sanitizeId(" Parse Token: Validation! ")).toBe(
			"parse-token-validation",
		);
		expect(sanitizeId("!!!", "fallback")).toBe("fallback");
	});

	it("truncates long ids without trailing separators", () => {
		const id = sanitizeId("a".repeat(80));

		expect(id).toHaveLength(48);
		expect(id.endsWith("-")).toBe(false);
	});

	it("creates deterministic short hashes", () => {
		expect(shortHash("/repo/path")).toBe(shortHash("/repo/path"));
		expect(shortHash("/repo/path")).not.toBe(shortHash("/repo/other"));
	});

	it("creates project keys from basename and absolute path hash", () => {
		const key = createProjectKey("/home/user/projects/pi-planner");

		expect(key).toMatch(/^pi-planner-[a-f0-9]{8}$/);
		expect(createProjectKey("/home/user/a-b")).not.toBe(
			createProjectKey("/home/user/a/b"),
		);
	});

	it("creates dated plan ids", () => {
		const id = createPlanId(
			"Auth Refactor",
			new Date("2026-05-15T00:00:00.000Z"),
		);

		expect(id).toBe("auth-refactor-20260515");
	});

	it("creates work item and attempt ids", () => {
		expect(createWorkItemId("Parser API")).toBe("parser-api");
		expect(createAttemptId(3)).toBe("attempt-3");
		expect(() => createAttemptId(0)).toThrow(/positive integer/);
	});
});

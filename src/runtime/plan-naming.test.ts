import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
import type { ProjectRecord } from "../storage/schema";
import {
	createPlannerPlanDescription,
	createPlannerPlanTitle,
	parsePlannerCreateCommandArgs,
	resolvePlannerPlanId,
	validatePlannerPlanTitle,
} from "./plan-naming";

function projectWithPlans(planIds: string[]): ProjectRecord {
	return {
		schemaVersion: SCHEMA_VERSION,
		projectId: "project-a",
		projectRoot: "/repo/app",
		displayName: "app",
		activePlanId: null,
		plans: planIds.map((planId) => ({
			planId,
			title: planId,
			description: planId,
			status: "active",
		})),
	};
}

describe("planner plan naming", () => {
	it("parses request-only command args", () => {
		expect(parsePlannerCreateCommandArgs("Fix approval find command")).toEqual({
			request: "Fix approval find command",
		});
	});

	it("rejects create id flags", () => {
		expect(
			parsePlannerCreateCommandArgs(
				"--id approval-find Fix approval find command",
			),
		).toBeNull();
		expect(parsePlannerCreateCommandArgs("--id=approval-find")).toBeNull();
	});

	it("allows the multiline editor to collect a missing request", () => {
		expect(parsePlannerCreateCommandArgs("")).toEqual({});
	});

	it("uses sanitized explicit id when provided", () => {
		expect(
			resolvePlannerPlanId({
				requestedPlanId: "Approval Find!",
				request: "Ignored",
				project: projectWithPlans(["approval-find"]),
			}),
		).toMatch(/^approval-find-[a-f0-9]{8}$/);
	});

	it("rejects explicit id that cannot become a valid planner id", () => {
		expect(() =>
			resolvePlannerPlanId({
				requestedPlanId: "!!!",
				request: "Valid request",
				project: projectWithPlans([]),
			}),
		).toThrow("Invalid planner id");
	});

	it("generates a compact unique id from request", () => {
		expect(
			resolvePlannerPlanId({
				request: "Fix approval find command",
				project: projectWithPlans([]),
			}),
		).toMatch(/^fix-approval-find-command-[a-f0-9]{8}$/);
	});

	it("keeps generated ids unique with a short uuid suffix", () => {
		const result = resolvePlannerPlanId({
			request: "Fix approval find command",
			project: projectWithPlans(["fix-approval-find-command"]),
		});
		expect(result).toMatch(/^fix-approval-find-command-[a-f0-9]{8}$/);
	});

	it("uses uuid suffix for generated ids", () => {
		const result = resolvePlannerPlanId({
			request: "Fix approval find command",
			project: projectWithPlans(["fix-approval-find-command"]),
		});
		expect(result).toMatch(/^fix-approval-find-command-[a-f0-9]{8}$/);
	});

	it("removes dots from generated path ids", () => {
		const result = resolvePlannerPlanId({
			request: "watcher json.timer tools",
			project: projectWithPlans([]),
		});
		expect(result).toMatch(/^watcher-json-timer-tools-[a-f0-9]{8}$/);
		expect(result).not.toContain(".");
	});

	it("keeps generated ids and titles bounded for multiline requests", () => {
		const request = `${"Implement a carefully described planner improvement ".repeat(4)}\nwith details`;

		expect(
			resolvePlannerPlanId({
				request,
				project: projectWithPlans([]),
			}).length,
		).toBeLessThanOrEqual(48);
		expect(createPlannerPlanTitle(request)).toBe(
			"Implement a carefully described planner improvement",
		);
	});

	it("keeps generated titles short and accepts user titles in any language", () => {
		expect(
			createPlannerPlanTitle(
				"Implement a carefully described planner improvement with many details",
			),
		).toBe("Implement a carefully described planner improvement");
		expect(validatePlannerPlanTitle("Быстрый поиск памяти")).toBe(
			"Быстрый поиск памяти",
		);
		expect(() => validatePlannerPlanTitle(" \n ")).toThrow(
			"title must be a non-empty string",
		);
	});

	it("creates concise plan descriptions from raw requests", () => {
		expect(
			createPlannerPlanDescription("  Fix   the planner resume UI  "),
		).toBe("Fix the planner resume UI");
		expect(createPlannerPlanDescription("x".repeat(220))).toHaveLength(160);
	});
});

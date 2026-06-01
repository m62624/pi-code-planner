import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
import type { ProjectRecord } from "../storage/schema";
import {
	createPlannerPlanTitle,
	parsePlannerCreateCommandArgs,
	resolvePlannerPlanId,
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

	it("parses explicit id before the request", () => {
		expect(
			parsePlannerCreateCommandArgs(
				"--id approval-find Fix approval find command",
			),
		).toEqual({
			planId: "approval-find",
			request: "Fix approval find command",
		});
	});

	it("parses explicit id assignment and quoted request", () => {
		expect(
			parsePlannerCreateCommandArgs('--id=approval-find "Fix find command"'),
		).toEqual({
			planId: "approval-find",
			request: "Fix find command",
		});
	});

	it("rejects missing request and malformed id flag", () => {
		expect(parsePlannerCreateCommandArgs("")).toBeNull();
		expect(parsePlannerCreateCommandArgs("--id")).toBeNull();
		expect(parsePlannerCreateCommandArgs("--id plan-a")).toBeNull();
	});

	it("uses sanitized explicit id when provided", () => {
		expect(
			resolvePlannerPlanId({
				requestedPlanId: "Approval Find!",
				request: "Ignored",
				project: projectWithPlans(["approval-find"]),
			}),
		).toBe("approval-find");
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

	it("generates deterministic id from request", () => {
		expect(
			resolvePlannerPlanId({
				request: "Fix approval find command",
				project: projectWithPlans([]),
			}),
		).toBe("fix-approval-find-command");
	});

	it("adds numeric suffix when generated id already exists", () => {
		expect(
			resolvePlannerPlanId({
				request: "Fix approval find command",
				project: projectWithPlans([
					"fix-approval-find-command",
					"fix-approval-find-command-2",
				]),
			}),
		).toBe("fix-approval-find-command-3");
	});

	it("keeps generated ids and titles bounded for multiline requests", () => {
		const request = `${"Implement a carefully described planner improvement ".repeat(4)}\nwith details`;

		expect(
			resolvePlannerPlanId({
				request,
				project: projectWithPlans([]),
			}).length,
		).toBeLessThanOrEqual(48);
		expect(createPlannerPlanTitle(request)).toHaveLength(80);
		expect(createPlannerPlanTitle(request)).toMatch(/\.\.\.$/);
	});
});

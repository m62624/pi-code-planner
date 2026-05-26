import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
import type { ProjectRecord } from "../storage/schema";
import {
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
	it("parses title-only command args", () => {
		expect(parsePlannerCreateCommandArgs("Fix approval find command")).toEqual({
			title: "Fix approval find command",
		});
	});

	it("parses explicit id before the title", () => {
		expect(
			parsePlannerCreateCommandArgs(
				"--id approval-find Fix approval find command",
			),
		).toEqual({
			planId: "approval-find",
			title: "Fix approval find command",
		});
	});

	it("parses explicit id assignment and quoted title", () => {
		expect(
			parsePlannerCreateCommandArgs('--id=approval-find "Fix find command"'),
		).toEqual({
			planId: "approval-find",
			title: "Fix find command",
		});
	});

	it("rejects missing title and malformed id flag", () => {
		expect(parsePlannerCreateCommandArgs("")).toBeNull();
		expect(parsePlannerCreateCommandArgs("--id")).toBeNull();
		expect(parsePlannerCreateCommandArgs("--id plan-a")).toBeNull();
	});

	it("uses sanitized explicit id when provided", () => {
		expect(
			resolvePlannerPlanId({
				requestedPlanId: "Approval Find!",
				title: "Ignored",
				project: projectWithPlans(["approval-find"]),
			}),
		).toBe("approval-find");
	});

	it("rejects explicit id that cannot become a valid planner id", () => {
		expect(() =>
			resolvePlannerPlanId({
				requestedPlanId: "!!!",
				title: "Valid title",
				project: projectWithPlans([]),
			}),
		).toThrow("Invalid planner id");
	});

	it("generates deterministic id from title", () => {
		expect(
			resolvePlannerPlanId({
				title: "Fix approval find command",
				project: projectWithPlans([]),
			}),
		).toBe("fix-approval-find-command");
	});

	it("adds numeric suffix when generated id already exists", () => {
		expect(
			resolvePlannerPlanId({
				title: "Fix approval find command",
				project: projectWithPlans([
					"fix-approval-find-command",
					"fix-approval-find-command-2",
				]),
			}),
		).toBe("fix-approval-find-command-3");
	});
});

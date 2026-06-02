import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SCHEMA_VERSION } from "../constants";
import type { ProjectRecord } from "../storage/schema";
import {
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

	it("allows the multiline editor to collect a missing request", () => {
		expect(parsePlannerCreateCommandArgs("")).toEqual({});
		expect(parsePlannerCreateCommandArgs("--id plan-a")).toEqual({
			planId: "plan-a",
		});
	});

	it("rejects malformed id flag", () => {
		expect(parsePlannerCreateCommandArgs("--id")).toBeNull();
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
		).toBe("fix-approv");
	});

	it("adds short hash suffix when generated id already exists", () => {
		const result = resolvePlannerPlanId({
			request: "Fix approval find command",
			project: projectWithPlans(["fix-approv"]),
		});
		expect(result).toMatch(/^fix-approv-[a-z0-9]{4}$/);
	});

	it("adds numeric suffix when hash collision also exists", () => {
		expect(
			resolvePlannerPlanId({
				request: "Fix approval find command",
				project: projectWithPlans([
					"fix-approv",
					`fix-approv-${createHash("sha256").update("Fix approval find command").digest("hex").slice(0, 4)}`,
				]),
			}),
		).toBe("fix-approv-2");
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
});

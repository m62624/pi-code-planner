import { describe, expect, it } from "vitest";
import { findPlannerToolOwnerSteps } from "./tool-policy";

describe("findPlannerToolOwnerSteps", () => {
	it("names the step that owns a submit tool", () => {
		const owners = findPlannerToolOwnerSteps("planner_questions_submit");
		expect(owners).toContain("discovery/write_questions");
	});

	it("lists steps in the preferred stage first", () => {
		// planner_contract_read is allowed across several stages; when the model is
		// in execution, execution steps should be surfaced before others.
		const owners = findPlannerToolOwnerSteps(
			"planner_contract_read",
			"execution",
		);
		expect(owners.length).toBeGreaterThan(1);
		expect(owners[0]?.startsWith("execution/")).toBe(true);
	});

	it("returns an empty list for a tool no step allows", () => {
		// planner_status is always-allowed, not gated per step, so it has no owner
		// in STEP_ALLOWED_TOOLS.
		expect(findPlannerToolOwnerSteps("planner_status")).toEqual([]);
	});
});

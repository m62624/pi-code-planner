import { describe, expect, it } from "vitest";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import {
	executePlannerWorkflowTool,
	workflowToolTransition,
} from "./workflow-tools";

describe("workflowToolTransition", () => {
	it("rejects unknown stage ids instead of casting them", () => {
		expect(() =>
			workflowToolTransition("planner_finish_step", {
				nextStage: "finalization",
				nextStep: "verify_plan_branch",
			}),
		).toThrow("nextStage must be one of");
	});

	it("rejects steps that do not belong to the selected stage", () => {
		expect(() =>
			workflowToolTransition("planner_finish_step", {
				nextStage: "finalize",
				nextStep: "prepare_task",
			}),
		).toThrow("nextStep must be one of finalize steps");
	});

	it("returns a blocked tool result for invalid exact stage ids", async () => {
		const result = await executePlannerWorkflowTool({
			fs: {} as PlannerFs,
			git: {} as GitRunner,
			projectPaths: {} as ProjectStoragePaths,
			toolName: "planner_finish_step",
			params: {
				nextStage: "finalization",
				nextStep: "verify_plan_branch",
			},
		});

		expect(result.result.status).toBe("blocked");
		expect(result.text).toContain("nextStage must be one of");
		expect(result.text).toContain("Call planner_status");
	});
});

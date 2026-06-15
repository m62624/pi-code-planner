import { describe, expect, it } from "vitest";
import {
	getAllowedPlannerWrapperTools,
	type PlannerWrapperTool,
} from "../guard/tool-policy";
import type { PlannerStage, PlannerStep } from "../storage/schema";
import {
	checkPlannerStageBehaviorWrapperTool,
	getPlannerStageStepBehavior,
} from "./stage-behavior";

// Each structured fill-tool must be permitted by BOTH allowlists at every step
// where it is used: the guard policy (STEP_ALLOWED_TOOLS) and the stage-behavior
// expectedTools gate. Missing either one deadlocks the model — and for tdd.md,
// where built-in edit/write is blocked, there is no fallback at all.
const FILL_TOOL_STEPS: Array<{
	stage: PlannerStage;
	step: PlannerStep;
	tool: PlannerWrapperTool;
}> = [
	{
		stage: "discovery",
		step: "scan_project_structure",
		tool: "planner_discovery_submit",
	},
	{ stage: "planning", step: "draft_plan", tool: "planner_plan_submit" },
	{ stage: "execution", step: "write_tdd_plan", tool: "planner_tdd_submit" },
	{ stage: "execution", step: "write_tests", tool: "planner_tdd_submit" },
	{ stage: "execution", step: "run_failing_tests", tool: "planner_tdd_submit" },
	{ stage: "execution", step: "implement_task", tool: "planner_tdd_submit" },
	{ stage: "execution", step: "contract_check", tool: "planner_tdd_submit" },
	{ stage: "execution", step: "refactor_task", tool: "planner_tdd_submit" },
	{ stage: "execution", step: "run_final_tests", tool: "planner_tdd_submit" },
	{
		stage: "execution",
		step: "merge_task_to_plan",
		tool: "planner_tdd_submit",
	},
	{
		stage: "finalize",
		step: "write_final_summary",
		tool: "planner_summary_submit",
	},
	{ stage: "done", step: "handle_change_request", tool: "planner_plan_submit" },
	{
		stage: "done",
		step: "handle_change_request",
		tool: "planner_discovery_submit",
	},
];

describe("artifact fill-tool gating", () => {
	for (const { stage, step, tool } of FILL_TOOL_STEPS) {
		it(`${tool} is allowed by both gates at ${stage}/${step}`, () => {
			const policyAllowed = getAllowedPlannerWrapperTools({
				stage,
				step,
				broken: false,
				requiresUserDecision: false,
				requiresCompact: false,
				debugArtifactsDir: null,
			});
			expect(policyAllowed).toContain(tool);

			const behaviorDecision = checkPlannerStageBehaviorWrapperTool({
				behavior: getPlannerStageStepBehavior({ stage, step }),
				tool,
			});
			expect(behaviorDecision.allow).toBe(true);
		});
	}
});

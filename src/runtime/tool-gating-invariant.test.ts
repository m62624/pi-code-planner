import { describe, expect, it } from "vitest";
import {
	getAllowedPlannerWrapperTools,
	type PlannerWrapperTool,
} from "../guard/tool-policy";
import {
	PLANNER_STAGE_STEPS,
	type PlannerStage,
	type PlannerStep,
} from "../storage/schema";
import {
	checkPlannerStageBehaviorWrapperTool,
	getPlannerStageStepBehavior,
} from "./stage-behavior";

// Invariant: a planner tool is usable at a step only if it passes BOTH gates —
// the guard policy (STEP_ALLOWED_TOOLS) and the stage-behavior expectedTools
// gate. So everything the guard permits MUST also pass the behavior gate;
// otherwise the guard advertises a tool the model can never actually call
// (a deadlock when no fallback exists, as happened with the artifact fill-tools).
//
// This guards against the two allowlists drifting apart for any tool — debug
// wrappers, git wrappers, contract tools, skills, or future additions.
describe("planner tool gating invariant", () => {
	it("every guard-allowed wrapper passes the behavior gate at every step", () => {
		const steps = Object.entries(PLANNER_STAGE_STEPS) as Array<
			[PlannerStage, readonly PlannerStep[]]
		>;
		const violations: string[] = [];

		for (const [stage, stepList] of steps) {
			for (const step of stepList) {
				// debugArtifactsDir set so debug wrappers are included in the guard
				// set and therefore checked against the behavior gate too.
				const allowed = getAllowedPlannerWrapperTools({
					stage,
					step,
					broken: false,
					requiresUserDecision: false,
					requiresCompact: false,
					debugArtifactsDir: "/tmp/planner-debug",
				});
				const behavior = getPlannerStageStepBehavior({ stage, step });
				for (const tool of allowed as readonly PlannerWrapperTool[]) {
					if (!checkPlannerStageBehaviorWrapperTool({ behavior, tool }).allow) {
						violations.push(`${stage}/${step}: ${tool}`);
					}
				}
			}
		}

		expect(violations, violations.join("\n")).toEqual([]);
	});
});

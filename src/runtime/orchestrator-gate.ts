import type { PlannerWrapperTool } from "../guard/tool-policy";
import type { PlannerLifecycleDecision } from "./lifecycle";
import type { PlannerPreflightResult } from "./preflight";
import {
	checkPlannerStageBehaviorWrapperTool,
	type PlannerStageStepBehavior,
} from "./stage-behavior";

export interface PlannerWrapperLifecycleGateInput {
	preflight: PlannerPreflightResult;
	lifecycle: PlannerLifecycleDecision;
	behavior: PlannerStageStepBehavior | null;
	tool: PlannerWrapperTool;
}

export interface PlannerWrapperLifecycleGateDecision {
	allow: boolean;
	tool: PlannerWrapperTool;
	reason: string | null;
}

export function filterPlannerWrapperToolsForLifecycle(input: {
	preflight: PlannerPreflightResult;
	lifecycle: PlannerLifecycleDecision;
	behavior: PlannerStageStepBehavior | null;
	tools: readonly PlannerWrapperTool[];
}): readonly PlannerWrapperTool[] {
	return input.tools.filter(
		(tool) =>
			checkPlannerWrapperToolForLifecycle({
				preflight: input.preflight,
				lifecycle: input.lifecycle,
				behavior: input.behavior,
				tool,
			}).allow,
	);
}

export function checkPlannerWrapperToolForLifecycle(
	input: PlannerWrapperLifecycleGateInput,
): PlannerWrapperLifecycleGateDecision {
	// planner_status and planner_artifact_read are read-only and must work in any
	// state, including before the next step is started (stepStatus !== running).
	if (
		input.tool === "planner_status" ||
		input.tool === "planner_artifact_read"
	) {
		return allowLifecycleTool(input.tool);
	}

	// The stage-behavior gate (expectedTools) is only composed with the guard
	// allowlist on the normal allow_stage_machine path. Broken/user-decision/
	// compact states return here and skip it entirely — those paths fall back
	// to whatever guard/tool-policy.ts allows directly. A step-scoped tool must
	// never leak into the broken/user-decision/compact allowed sets, or it
	// would bypass this gate unintentionally.
	if (
		input.preflight.context.status !== "ready" ||
		!input.behavior ||
		input.preflight.decision.action !== "allow_stage_machine"
	) {
		return allowLifecycleTool(input.tool);
	}

	const state = input.preflight.context.state;
	if (state.stepStatus !== "running") {
		return blockLifecycleTool(
			input.tool,
			`Planner wrapper ${input.tool} is blocked because ${state.stage}/${state.step} is ${state.stepStatus}. Call the required workflow transition first: ${input.lifecycle.requiredTool ?? "planner_status"}.`,
		);
	}

	const behaviorDecision = checkPlannerStageBehaviorWrapperTool({
		behavior: input.behavior,
		tool: input.tool,
	});
	return behaviorDecision.allow
		? allowLifecycleTool(input.tool)
		: blockLifecycleTool(input.tool, behaviorDecision.reason ?? "blocked");
}

function allowLifecycleTool(
	tool: PlannerWrapperTool,
): PlannerWrapperLifecycleGateDecision {
	return { allow: true, tool, reason: null };
}

function blockLifecycleTool(
	tool: PlannerWrapperTool,
	reason: string,
): PlannerWrapperLifecycleGateDecision {
	return { allow: false, tool, reason };
}

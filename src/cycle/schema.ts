import type { PlannerDecision } from "../decision/engine";
import type { AssemblePlannerPromptResult } from "../prompts/assembler";
import type { PlannerRuntimeInspection } from "../runtime/planner-runtime-controller";
import type { InstructionName } from "../settings/schema";

export type PlannerNextStepStatus = "idle" | "blocked" | "ready" | "terminal";

export type PlannerNextStepKind =
	| "idle"
	| "recovery"
	| "compact_pending"
	| "compact_required"
	| "memory_refresh"
	| "plan_stage"
	| "work_item_stage"
	| "terminal";

export type PlannerRequiredTool =
	| "planner_runtime_status"
	| "planner_request_discovery_compact"
	| "planner_request_work_item_compact"
	| "planner_memory_get_dirty"
	| "planner_memory_clear_dirty"
	| "planner_accept_current_git_state"
	| "planner_soft_reset_to_expected"
	| "planner_hard_reset_to_expected"
	| "planner_transition_plan"
	| "planner_transition_work_item"
	| null;

export interface PlannerNextStep {
	status: PlannerNextStepStatus;
	kind: PlannerNextStepKind;
	blocking: boolean;
	message: string;
	decision: PlannerDecision;
	requiredTool: PlannerRequiredTool;
	instructionName: InstructionName | null;
	/** Markdown section selected for the current stage, when known. */
	sectionName: string | null;
	prompt: AssemblePlannerPromptResult | null;
	artifactPaths: string[];
	dirtyFiles: string[];
	compact: {
		required: boolean;
		reason: "discovery" | "work_item" | null;
		requestTool:
			| "planner_request_discovery_compact"
			| "planner_request_work_item_compact"
			| null;
		resumePurpose: string | null;
	};
	inspection: PlannerRuntimeInspection;
}

import type { PlannerRuntimeController } from "../runtime/planner-runtime-controller";
import type { InstructionName } from "../settings/schema";
import type { PlanStage, WorkItemStage } from "../workflow/schema";
import type {
	PlannerNextStep,
	PlannerNextStepKind,
	PlannerNextStepStatus,
	PlannerRequiredTool,
} from "./schema";

export interface PlannerCycleManagerOptions {
	runtime: PlannerRuntimeController;
}

function instructionForPlanStage(
	stage: PlanStage | null,
): InstructionName | null {
	if (!stage) return null;
	if (stage === "discovery_full") return "discovery";
	if (stage === "discovery_compact_required") return "compact";
	if (stage === "plan_finalize" || stage === "plan_completed") {
		return "documentation";
	}
	return "plan";
}

function instructionForWorkItemStage(
	stage: WorkItemStage | null,
): InstructionName | null {
	if (!stage) return null;
	if (stage === "refactor") return "refactor";
	if (stage === "verification") return "api_check";
	if (stage === "work_item_compact_required") return "compact";
	if (stage === "completed") return "documentation";
	return "work_item";
}

function instructionFromDecision(
	decision: PlannerNextStep["decision"],
): InstructionName | null {
	return (
		instructionForWorkItemStage(decision.workItemStage) ??
		instructionForPlanStage(decision.planStage)
	);
}

function compactRequestTool(
	reason: PlannerNextStep["compact"]["reason"],
): PlannerNextStep["compact"]["requestTool"] {
	if (reason === "discovery") return "planner_request_discovery_compact";
	if (reason === "work_item") return "planner_request_work_item_compact";
	return null;
}

function compactResumePurpose(
	reason: PlannerNextStep["compact"]["reason"],
): string | null {
	if (reason === "discovery") {
		return "After compaction, reload plan discovery artifacts and compressed project memory, then continue with post-discovery questions.";
	}
	if (reason === "work_item") {
		return "After compaction, reload the active plan, completed work item artifacts, and compressed project memory before selecting the next unit.";
	}
	return null;
}

function kindFromDecision(
	status: PlannerNextStep["decision"]["status"],
): PlannerNextStepKind {
	switch (status) {
		case "idle":
			return "idle";
		case "recovery_required":
			return "recovery";
		case "compact_pending":
			return "compact_pending";
		case "compact_required":
			return "compact_required";
		case "memory_refresh_required":
			return "memory_refresh";
		case "plan_stage":
			return "plan_stage";
		case "work_item_stage":
			return "work_item_stage";
		case "terminal":
			return "terminal";
	}
}

function statusFromKind(
	kind: PlannerNextStepKind,
	blocking: boolean,
): PlannerNextStepStatus {
	if (kind === "idle") return "idle";
	if (kind === "terminal") return "terminal";
	if (blocking) return "blocked";
	return "ready";
}

function requiredToolFromKind(step: {
	kind: PlannerNextStepKind;
	compactTool: PlannerNextStep["compact"]["requestTool"];
}): PlannerRequiredTool {
	switch (step.kind) {
		case "idle":
		case "plan_stage":
		case "work_item_stage":
		case "terminal":
			return null;
		case "compact_pending":
			return "planner_runtime_status";
		case "compact_required":
			return step.compactTool;
		case "memory_refresh":
			return "planner_memory_get_dirty";
		case "recovery":
			return "planner_runtime_status";
	}
}

export class PlannerCycleManager {
	constructor(private options: PlannerCycleManagerOptions) {}

	async getNextStep(): Promise<PlannerNextStep> {
		const inspection = await this.options.runtime.inspect();
		const decision = inspection.decision;
		const kind = kindFromDecision(decision.status);
		const compactTool = compactRequestTool(decision.compactReason);
		const status = statusFromKind(kind, decision.blocking);
		const prompt = inspection.nextPrompt;

		return {
			status,
			kind,
			blocking: decision.blocking,
			message: decision.message,
			decision,
			requiredTool: requiredToolFromKind({ kind, compactTool }),
			instructionName: instructionFromDecision(decision),
			sectionName: null,
			prompt,
			artifactPaths: prompt?.artifactPaths ?? [],
			dirtyFiles: decision.dirtyFiles,
			compact: {
				required: kind === "compact_required",
				reason: decision.compactReason,
				requestTool: compactTool,
				resumePurpose: compactResumePurpose(decision.compactReason),
			},
			inspection,
		};
	}
}

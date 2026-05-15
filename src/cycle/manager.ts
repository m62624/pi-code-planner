import type { PlannerRuntimeController } from "../runtime/planner-runtime-controller";
import {
	instructionForPlanStage,
	instructionForWorkItemStage,
	type StageInstructionRef,
} from "../workflow/instructions";
import type {
	PlannerNextStep,
	PlannerNextStepKind,
	PlannerNextStepStatus,
	PlannerRequiredTool,
} from "./schema";

export interface PlannerCycleManagerOptions {
	runtime: PlannerRuntimeController;
}

function instructionFromDecision(
	decision: PlannerNextStep["decision"],
): StageInstructionRef | null {
	return (
		(decision.workItemStage
			? instructionForWorkItemStage(decision.workItemStage)
			: null) ??
		(decision.planStage ? instructionForPlanStage(decision.planStage) : null)
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

function compactPayload(input: {
	reason: PlannerNextStep["compact"]["reason"];
	prompt: PlannerNextStep["prompt"];
	artifactPaths: string[];
	planId: string | null;
	workItemId: string | null;
}): PlannerNextStep["compact"]["payload"] {
	if (!input.reason) return null;

	const artifactLines =
		input.artifactPaths.length > 0
			? input.artifactPaths.map((path) => `- ${path}`).join("\n")
			: "- none";
	const compactInstruction =
		input.prompt?.prompt ??
		`Compact the active planner ${input.reason} boundary. Preserve current planner state, decisions, risks, and next action.`;
	const scopeLines = [
		`- reason: ${input.reason}`,
		`- planId: ${input.planId ?? "null"}`,
		`- workItemId: ${input.workItemId ?? "null"}`,
	].join("\n");
	const resumePurpose = compactResumePurpose(input.reason);

	return {
		customInstructions: [
			compactInstruction,
			"## Compact Scope",
			scopeLines,
			"## Planner Artifacts",
			artifactLines,
		].join("\n\n"),
		resumePrompt: [
			"Resume the planner workflow after compact.",
			resumePurpose,
			"",
			"Before continuing, call planner_next_step and follow its requiredTool or NEXT PLANNER INSTRUCTION.",
		]
			.filter((line): line is string => line !== null)
			.join("\n"),
	};
}

function memoryRefreshPayload(input: {
	kind: PlannerNextStepKind;
	dirtyFiles: string[];
}): PlannerNextStep["memoryRefresh"] {
	const required = input.kind === "memory_refresh";
	return {
		required,
		dirtyFiles: input.dirtyFiles,
		requiredTools: required
			? [
					"planner_memory_get_dirty",
					"planner_memory_upsert_files",
					"planner_memory_upsert_symbols",
					"planner_memory_upsert_relations",
					"planner_memory_verify_file",
					"planner_memory_verify_symbol",
					"planner_memory_clear_dirty",
					"planner_transition_work_item",
				]
			: [],
		instructions: required
			? [
					"Enter or continue the signature_refresh stage for the active work item.",
					"Call planner_memory_get_dirty and refresh only the listed dirty files.",
					"Read each dirty file enough to update file, symbol, and relation memory accurately.",
					"Use planner_memory_upsert_files, planner_memory_upsert_symbols, and planner_memory_upsert_relations for changed entries.",
					"Verify refreshed entries with planner_memory_verify_file and planner_memory_verify_symbol when applicable.",
					"Only after memory is accurate, call planner_memory_clear_dirty for refreshed files.",
					"Then call planner_transition_work_item to move from signature_refresh to work_item_compact_required.",
				]
			: [],
	};
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
		const instruction = instructionFromDecision(decision);
		const artifactPaths = prompt?.artifactPaths ?? [];
		const dirtyFiles = decision.dirtyFiles;

		return {
			status,
			kind,
			blocking: decision.blocking,
			message: decision.message,
			decision,
			requiredTool: requiredToolFromKind({ kind, compactTool }),
			instructionName: instruction?.instructionName ?? null,
			sectionName: instruction?.sectionName ?? null,
			prompt,
			artifactPaths,
			dirtyFiles,
			memoryRefresh: memoryRefreshPayload({ kind, dirtyFiles }),
			compact: {
				required: kind === "compact_required",
				reason: decision.compactReason,
				requestTool: compactTool,
				resumePurpose: compactResumePurpose(decision.compactReason),
				payload: compactPayload({
					reason: decision.compactReason,
					prompt,
					artifactPaths,
					planId:
						inspection.plan?.planId ??
						decision.recovery.currentBranch?.planId ??
						null,
					workItemId:
						inspection.workItem?.workItemId ??
						decision.recovery.currentBranch?.workItemId ??
						null,
				}),
			},
			inspection,
		};
	}
}

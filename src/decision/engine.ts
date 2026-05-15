import type { GitRecoveryAnalysis } from "../git/recovery";
import { analyzeGitRecovery } from "../git/recovery";
import type { RepoState } from "../git/state";
import type { DirtyMemoryState } from "../memory/schema";
import type { PlannerRuntimeState } from "../planner-state/schema";
import type { PlanRecord, WorkItemRecord } from "../storage/schema";

export type PlannerDecisionStatus =
	| "idle"
	| "recovery_required"
	| "compact_pending"
	| "compact_required"
	| "memory_refresh_required"
	| "plan_stage"
	| "work_item_stage"
	| "terminal";

export type PlannerDecisionAction =
	| "none"
	| "recover_git"
	| "wait_for_compact_resume"
	| "request_discovery_compact"
	| "request_work_item_compact"
	| "refresh_memory"
	| "continue_plan_stage"
	| "continue_work_item_stage"
	| "finalize";

export interface PlannerDecisionInput {
	state: PlannerRuntimeState;
	repo: RepoState;
	memory: DirtyMemoryState;
	plan?: PlanRecord | null;
	workItem?: WorkItemRecord | null;
	recovery?: GitRecoveryAnalysis;
}

export interface PlannerDecision {
	status: PlannerDecisionStatus;
	action: PlannerDecisionAction;
	blocking: boolean;
	message: string;
	recovery: GitRecoveryAnalysis;
	dirtyFiles: string[];
	compactReason: "discovery" | "work_item" | null;
	planStage: PlanRecord["stage"] | null;
	workItemStage: WorkItemRecord["stage"] | null;
}

function dirtyFiles(memory: DirtyMemoryState): string[] {
	return Object.keys(memory.files).sort();
}

function isTerminalPlan(plan: PlanRecord | null | undefined): boolean {
	return (
		plan?.stage === "plan_completed" ||
		plan?.stage === "plan_cancelled" ||
		plan?.stage === "plan_finalize"
	);
}

function decision(
	input: PlannerDecisionInput,
	status: PlannerDecisionStatus,
	action: PlannerDecisionAction,
	blocking: boolean,
	message: string,
	compactReason: PlannerDecision["compactReason"] = null,
): PlannerDecision {
	const recovery =
		input.recovery ?? analyzeGitRecovery(input.state, input.repo);
	return {
		status,
		action,
		blocking,
		message,
		recovery,
		dirtyFiles: dirtyFiles(input.memory),
		compactReason,
		planStage: input.plan?.stage ?? null,
		workItemStage: input.workItem?.stage ?? null,
	};
}

export function decidePlannerNextAction(
	input: PlannerDecisionInput,
): PlannerDecision {
	const recovery =
		input.recovery ?? analyzeGitRecovery(input.state, input.repo);
	const nextInput = { ...input, recovery };

	if (recovery.status === "inactive") {
		return decision(nextInput, "idle", "none", false, "Planner is idle.");
	}

	const pendingCompact = input.state.pendingCompact;
	if (
		pendingCompact?.status === "requested" ||
		pendingCompact?.status === "completed"
	) {
		return decision(
			nextInput,
			"compact_pending",
			"wait_for_compact_resume",
			true,
			`Planner compact is pending: ${pendingCompact.id}.`,
		);
	}

	if (recovery.requiresRecovery) {
		return decision(
			nextInput,
			"recovery_required",
			"recover_git",
			true,
			recovery.message,
		);
	}

	const dirty = dirtyFiles(input.memory);
	if (dirty.length > 0 && input.workItem?.stage !== "signature_refresh") {
		return decision(
			nextInput,
			"memory_refresh_required",
			"refresh_memory",
			true,
			"Project memory has dirty files; run signature_refresh before commit or compact.",
		);
	}

	if (input.plan?.stage === "discovery_compact_required") {
		return decision(
			nextInput,
			"compact_required",
			"request_discovery_compact",
			true,
			"Discovery compact is required before planner can continue.",
			"discovery",
		);
	}

	if (input.workItem?.stage === "work_item_compact_required") {
		return decision(
			nextInput,
			"compact_required",
			"request_work_item_compact",
			true,
			"Work item compact is required before planner can continue.",
			"work_item",
		);
	}

	if (isTerminalPlan(input.plan)) {
		return decision(
			nextInput,
			"terminal",
			"finalize",
			false,
			`Planner is at terminal/final stage: ${input.plan?.stage}.`,
		);
	}

	if (input.workItem) {
		return decision(
			nextInput,
			"work_item_stage",
			"continue_work_item_stage",
			false,
			`Planner is ready at work item stage: ${input.workItem.stage}.`,
		);
	}

	if (input.plan) {
		return decision(
			nextInput,
			"plan_stage",
			"continue_plan_stage",
			false,
			`Planner is ready at plan stage: ${input.plan.stage}.`,
		);
	}

	return decision(
		nextInput,
		"recovery_required",
		"recover_git",
		true,
		"Planner runtime is active without an active plan id.",
	);
}

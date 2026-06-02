import {
	getAllowedPlannerWrapperTools,
	type PlannerWrapperTool,
} from "../guard/tool-policy";
import type {
	InitStep,
	PlannerStage,
	PlannerStep,
	PlanStateRecord,
} from "../storage/schema";
import type { ActivePlanContextStatus } from "./active-plan";
import type { PlannerGitReality } from "./git-state-sync";

export type PlannerRuntimeAction =
	| "allow_stage_machine"
	| "require_recovery"
	| "require_user_decision"
	| "require_compact"
	| "no_active_plan";

export type PlannerRuntimeRecoveryReason =
	| "missing_project"
	| "missing_plan"
	| "missing_state"
	| "missing_worktree"
	| "git_unavailable"
	| "wrong_branch"
	| "git_conflict"
	| "broken_state"
	| "user_decision_required";

export interface PlannerRuntimeRealityInput {
	contextStatus: ActivePlanContextStatus;
	state?: PlanStateRecord;
	git?: PlannerGitReality | null;
	worktreeExists?: boolean;
}

export interface PlannerRuntimeDecision {
	action: PlannerRuntimeAction;
	reason: string | null;
	recoveryReason: PlannerRuntimeRecoveryReason | null;
	allowedTools: readonly PlannerWrapperTool[];
	stage: PlannerStage | null;
	step: PlannerStep | null;
	nextStep: PlannerStep | null;
	requiresRecovery: boolean;
	requiresUserDecision: boolean;
	requiresCompact: boolean;
	git: PlannerGitReality | null;
}

const STATUS_ONLY_TOOLS = [
	"planner_status",
	"planner_create_plan",
] as const satisfies readonly PlannerWrapperTool[];

const RECOVERY_TOOLS = [
	"planner_status",
	"planner_git_inspect",
	"planner_recovery_inspect",
	"planner_recovery_resume",
] as const satisfies readonly PlannerWrapperTool[];

const INIT_STEPS_BEFORE_WORKTREE = new Set<InitStep>([
	"check_project",
	"check_git",
	"prepare_storage",
	"choose_worktree_location",
	"create_plan_record",
	"create_plan_worktree",
]);

export function evaluatePlannerRuntimeReality(
	input: PlannerRuntimeRealityInput,
): PlannerRuntimeDecision {
	if (
		input.contextStatus === "no_active_plan" ||
		input.contextStatus === "missing_project"
	) {
		return decision({
			input,
			action: "no_active_plan",
			reason:
				input.contextStatus === "missing_project"
					? "Project record does not exist."
					: "Project has no active planner plan.",
			allowedTools: STATUS_ONLY_TOOLS,
		});
	}

	if (input.contextStatus === "missing_plan") {
		return recovery(input, "missing_plan", "Active plan record is missing.");
	}

	if (input.contextStatus === "missing_state") {
		return recovery(input, "missing_state", "Active plan state is missing.");
	}

	if (!input.state) {
		return recovery(input, "missing_state", "Active plan state is missing.");
	}

	if (input.state.requiresUserDecision) {
		return userDecision(input, "Plan is waiting for a user decision.");
	}

	if (input.state.broken) {
		return recovery(
			input,
			"broken_state",
			input.state.brokenReason ?? "Plan state is marked broken.",
		);
	}

	if (
		(!input.state.worktreePath || input.worktreeExists === false) &&
		requiresPlannerWorktree(input.state)
	) {
		return recovery(
			input,
			"missing_worktree",
			"Expected planner worktree is missing.",
		);
	}

	if (!input.state.worktreePath || input.worktreeExists === false) {
		return decision({
			input,
			action: "allow_stage_machine",
			reason: null,
			allowedTools: getAllowedPlannerWrapperTools(input.state),
		});
	}

	if (!input.git) {
		return recovery(input, "git_unavailable", "Git reality is unavailable.");
	}

	if (input.git.hasConflicts) {
		return recovery(
			input,
			"git_conflict",
			"Git worktree has unresolved conflicts.",
		);
	}

	if (
		input.state.currentBranch !== null &&
		input.git.branch !== input.state.currentBranch
	) {
		return recovery(
			input,
			"wrong_branch",
			`Expected branch ${input.state.currentBranch}, got ${input.git.branch}.`,
		);
	}

	if (input.state.requiresCompact) {
		return decision({
			input,
			action: "require_compact",
			reason: "Planner compact boundary is pending.",
			allowedTools: getAllowedPlannerWrapperTools(input.state),
			requiresCompact: true,
		});
	}

	return decision({
		input,
		action: "allow_stage_machine",
		reason: null,
		allowedTools: getAllowedPlannerWrapperTools(input.state),
	});
}

function userDecision(
	input: PlannerRuntimeRealityInput,
	reason: string,
): PlannerRuntimeDecision {
	return decision({
		input,
		action: "require_user_decision",
		reason,
		recoveryReason: "user_decision_required",
		allowedTools: RECOVERY_TOOLS,
		requiresRecovery: true,
		requiresUserDecision: true,
	});
}

function recovery(
	input: PlannerRuntimeRealityInput,
	recoveryReason: PlannerRuntimeRecoveryReason,
	reason: string,
): PlannerRuntimeDecision {
	return decision({
		input,
		action: "require_recovery",
		reason,
		recoveryReason,
		allowedTools: RECOVERY_TOOLS,
		requiresRecovery: true,
	});
}

function decision(input: {
	input: PlannerRuntimeRealityInput;
	action: PlannerRuntimeAction;
	reason: string | null;
	recoveryReason?: PlannerRuntimeRecoveryReason | null;
	allowedTools: readonly PlannerWrapperTool[];
	requiresRecovery?: boolean;
	requiresUserDecision?: boolean;
	requiresCompact?: boolean;
}): PlannerRuntimeDecision {
	return {
		action: input.action,
		reason: input.reason,
		recoveryReason: input.recoveryReason ?? null,
		allowedTools: input.allowedTools,
		stage: input.input.state?.stage ?? null,
		step: input.input.state?.step ?? null,
		nextStep: input.input.state?.nextStep ?? null,
		requiresRecovery: input.requiresRecovery ?? false,
		requiresUserDecision: input.requiresUserDecision ?? false,
		requiresCompact: input.requiresCompact ?? false,
		git: input.input.git ?? null,
	};
}

function requiresPlannerWorktree(state: PlanStateRecord): boolean {
	return !(
		state.stage === "init" &&
		INIT_STEPS_BEFORE_WORKTREE.has(state.step as InitStep)
	);
}

import type {
	PlannerBranchRecord,
	PlannerRuntimeState,
} from "../planner-state/schema";
import type { RepoState } from "./state";

export type GitPolicyOperation =
	| "start_plan"
	| "start_work_item"
	| "finish_work_item"
	| "switch_branch"
	| "delete_branch"
	| "merge_branch"
	| "delete_plan"
	| "recover_external_change";

export type GitPolicyDecisionKind = "allow" | "block" | "recovery_required";

export type GitPolicyReason =
	| "allowed"
	| "init_required"
	| "not_git_repo"
	| "no_active_plan"
	| "missing_expected_branch"
	| "detached_head"
	| "wrong_branch"
	| "unexpected_commit"
	| "dirty_worktree"
	| "conflicts"
	| "no_changes"
	| "missing_branch_name"
	| "missing_target_branch"
	| "protected_branch"
	| "current_branch"
	| "unknown_branch";

export interface GitPolicyInput {
	operation: GitPolicyOperation;
	repoState: RepoState;
	plannerState: PlannerRuntimeState;
	branchName?: string;
	targetBranch?: string;
}

export interface GitPolicyDecision {
	kind: GitPolicyDecisionKind;
	reason: GitPolicyReason;
	message: string;
}

function allow(message = "Git operation is allowed."): GitPolicyDecision {
	return { kind: "allow", reason: "allowed", message };
}

function block(reason: GitPolicyReason, message: string): GitPolicyDecision {
	return { kind: "block", reason, message };
}

function recoveryRequired(
	reason: GitPolicyReason,
	message: string,
): GitPolicyDecision {
	return { kind: "recovery_required", reason, message };
}

function hasBlockingDirtyState(repoState: RepoState): boolean {
	return (
		repoState.status.hasStagedChanges ||
		repoState.status.hasUnstagedChanges ||
		repoState.status.hasUntrackedFiles
	);
}

function getManagedBranch(
	plannerState: PlannerRuntimeState,
	branchName: string,
): PlannerBranchRecord | null {
	return plannerState.branches.items[branchName] ?? null;
}

function checkExpectedPlanPosition({
	repoState,
	plannerState,
}: Pick<
	GitPolicyInput,
	"repoState" | "plannerState"
>): GitPolicyDecision | null {
	if (!plannerState.activePlanId) {
		return block("no_active_plan", "No planner plan is active.");
	}
	if (!repoState.isRepo) {
		return block("not_git_repo", "Planner git operation requires a git repo.");
	}
	if (repoState.isDetachedHead) {
		return recoveryRequired(
			"detached_head",
			"Repository is in detached HEAD while a planner plan is active.",
		);
	}
	if (!plannerState.git.expectedBranch) {
		return block(
			"missing_expected_branch",
			"Planner state does not have an expected git branch.",
		);
	}
	if (repoState.currentBranch !== plannerState.git.expectedBranch) {
		return recoveryRequired(
			"wrong_branch",
			`Expected branch ${plannerState.git.expectedBranch}, got ${repoState.currentBranch ?? "<none>"}.`,
		);
	}
	if (
		plannerState.git.expectedCommit &&
		repoState.currentCommit !== plannerState.git.expectedCommit
	) {
		return recoveryRequired(
			"unexpected_commit",
			`Expected commit ${plannerState.git.expectedCommit}, got ${repoState.currentCommit ?? "<none>"}.`,
		);
	}
	return null;
}

function checkStartPlan(repoState: RepoState): GitPolicyDecision {
	if (!repoState.isRepo) {
		return block(
			"init_required",
			"Git repository is missing. Initialize git before starting a plan.",
		);
	}
	if (repoState.isDetachedHead) {
		return block("detached_head", "Cannot start a plan from detached HEAD.");
	}
	if (repoState.status.hasConflicts) {
		return block("conflicts", "Resolve git conflicts before starting a plan.");
	}
	if (hasBlockingDirtyState(repoState)) {
		return block(
			"dirty_worktree",
			"Start plan requires a clean worktree with no staged, unstaged, or untracked files.",
		);
	}
	return allow("Plan can start from the current clean git state.");
}

function checkStartWorkItem(input: GitPolicyInput): GitPolicyDecision {
	const expectedPosition = checkExpectedPlanPosition(input);
	if (expectedPosition) return expectedPosition;
	if (input.repoState.status.hasConflicts) {
		return block(
			"conflicts",
			"Resolve git conflicts before starting a work item.",
		);
	}
	if (hasBlockingDirtyState(input.repoState)) {
		return block(
			"dirty_worktree",
			"Start work item requires a clean worktree.",
		);
	}
	return allow("Work item can start from the expected clean git state.");
}

function checkFinishWorkItem(input: GitPolicyInput): GitPolicyDecision {
	const expectedPosition = checkExpectedPlanPosition(input);
	if (expectedPosition) return expectedPosition;
	if (input.repoState.status.hasConflicts) {
		return block("conflicts", "Cannot finish a work item with git conflicts.");
	}
	if (!input.repoState.status.isDirty) {
		return block(
			"no_changes",
			"Cannot finish a work item without git changes.",
		);
	}
	return allow("Work item can be finished and committed by the planner.");
}

function checkSwitchBranch(input: GitPolicyInput): GitPolicyDecision {
	const expectedPosition = checkExpectedPlanPosition(input);
	if (expectedPosition) return expectedPosition;
	if (input.repoState.status.hasConflicts) {
		return block("conflicts", "Cannot switch branches with git conflicts.");
	}
	if (hasBlockingDirtyState(input.repoState)) {
		return block(
			"dirty_worktree",
			"Cannot switch branches with dirty worktree.",
		);
	}
	return allow("Branch switch is allowed.");
}

function checkMergeBranch(input: GitPolicyInput): GitPolicyDecision {
	const expectedPosition = checkExpectedPlanPosition(input);
	if (expectedPosition) return expectedPosition;
	if (input.repoState.status.hasConflicts) {
		return block("conflicts", "Cannot merge while git conflicts exist.");
	}
	if (hasBlockingDirtyState(input.repoState)) {
		return block("dirty_worktree", "Merge requires a clean target worktree.");
	}
	return allow("Merge is allowed from the expected clean git state.");
}

function checkDeleteBranch(input: GitPolicyInput): GitPolicyDecision {
	if (!input.plannerState.activePlanId) {
		return block("no_active_plan", "No planner plan is active.");
	}
	if (!input.branchName) {
		return block(
			"missing_branch_name",
			"Delete branch requires a branch name.",
		);
	}
	const branch = getManagedBranch(input.plannerState, input.branchName);
	if (input.branchName === input.repoState.currentBranch) {
		return block("current_branch", "Cannot delete the current branch.");
	}
	if (
		input.branchName === input.plannerState.git.baseBranch ||
		input.branchName === input.plannerState.git.planBranch ||
		input.branchName === input.plannerState.branches.baseBranch ||
		input.branchName === input.plannerState.branches.planBranch ||
		branch?.kind === "base" ||
		branch?.kind === "plan"
	) {
		return block(
			"protected_branch",
			"Base and main plan branches cannot be deleted automatically.",
		);
	}
	if (!branch || (branch.kind !== "child" && branch.kind !== "experiment")) {
		return block(
			"unknown_branch",
			"Only registered child or experiment branches can be deleted by the planner.",
		);
	}
	return allow("Managed child or experiment branch can be deleted.");
}

export function checkGitPolicy(input: GitPolicyInput): GitPolicyDecision {
	switch (input.operation) {
		case "start_plan":
			return checkStartPlan(input.repoState);
		case "start_work_item":
			return checkStartWorkItem(input);
		case "finish_work_item":
			return checkFinishWorkItem(input);
		case "switch_branch":
			return checkSwitchBranch(input);
		case "merge_branch":
			return checkMergeBranch(input);
		case "delete_branch":
			return checkDeleteBranch(input);
		case "delete_plan":
		case "recover_external_change":
			return allow("Recovery or cleanup operation is allowed to handle state.");
	}
}

import type {
	PlannerBranchRecord,
	PlannerRuntimeState,
} from "../planner-state/schema";
import type { RepoState } from "./state";

export type GitRecoveryStatus =
	| "ok"
	| "inactive"
	| "init_required"
	| "pending_operation"
	| "detached_head"
	| "conflicts"
	| "dirty_worktree"
	| "external_branch_change"
	| "external_commit_change"
	| "registered_experiment_branch"
	| "registered_child_branch"
	| "unknown_branch";

export interface GitRecoveryAnalysis {
	status: GitRecoveryStatus;
	requiresRecovery: boolean;
	message: string;
	currentBranch: PlannerBranchRecord | null;
	expectedBranch: PlannerBranchRecord | null;
}

function branchRecord(
	state: PlannerRuntimeState,
	branch: string | null,
): PlannerBranchRecord | null {
	if (!branch) return null;
	return state.branches.items[branch] ?? null;
}

function result(
	status: GitRecoveryStatus,
	message: string,
	currentBranch: PlannerBranchRecord | null,
	expectedBranch: PlannerBranchRecord | null,
): GitRecoveryAnalysis {
	return {
		status,
		requiresRecovery: status !== "ok" && status !== "inactive",
		message,
		currentBranch,
		expectedBranch,
	};
}

function isRuntimeActive(state: PlannerRuntimeState): boolean {
	return (
		state.activePlanId !== null ||
		state.mode === "operation_in_progress" ||
		state.mode === "recovery_required"
	);
}

export function analyzeGitRecovery(
	state: PlannerRuntimeState,
	repo: RepoState,
): GitRecoveryAnalysis {
	const currentBranch = branchRecord(state, repo.currentBranch);
	const expectedBranch = branchRecord(state, state.git.expectedBranch);

	if (!isRuntimeActive(state)) {
		return result(
			"inactive",
			"No planner runtime is active.",
			currentBranch,
			expectedBranch,
		);
	}

	if (state.pendingOperation) {
		return result(
			"pending_operation",
			`Pending git operation found: ${state.pendingOperation.type}.`,
			currentBranch,
			expectedBranch,
		);
	}

	if (!repo.isRepo) {
		return result(
			"init_required",
			"Git repository is missing.",
			currentBranch,
			expectedBranch,
		);
	}

	if (repo.isDetachedHead) {
		return result(
			"detached_head",
			"Repository is in detached HEAD.",
			currentBranch,
			expectedBranch,
		);
	}

	if (repo.status.hasConflicts) {
		return result(
			"conflicts",
			"Git conflicts must be resolved before planner can continue.",
			currentBranch,
			expectedBranch,
		);
	}

	if (repo.currentBranch !== state.git.expectedBranch) {
		if (!currentBranch) {
			return result(
				"unknown_branch",
				`Current branch is not managed by planner: ${repo.currentBranch ?? "<none>"}.`,
				currentBranch,
				expectedBranch,
			);
		}
		if (currentBranch.kind === "experiment") {
			return result(
				"registered_experiment_branch",
				`Current branch is a registered experiment branch: ${currentBranch.name}.`,
				currentBranch,
				expectedBranch,
			);
		}
		if (currentBranch.kind === "child") {
			return result(
				"registered_child_branch",
				`Current branch is a registered child branch: ${currentBranch.name}.`,
				currentBranch,
				expectedBranch,
			);
		}
		return result(
			"external_branch_change",
			`Expected branch ${state.git.expectedBranch ?? "<none>"}, got ${repo.currentBranch ?? "<none>"}.`,
			currentBranch,
			expectedBranch,
		);
	}

	if (
		state.git.expectedCommit &&
		repo.currentCommit !== state.git.expectedCommit
	) {
		return result(
			"external_commit_change",
			`Expected commit ${state.git.expectedCommit}, got ${repo.currentCommit ?? "<none>"}.`,
			currentBranch,
			expectedBranch,
		);
	}

	if (repo.status.isDirty) {
		return result(
			"dirty_worktree",
			"Worktree has uncommitted changes.",
			currentBranch,
			expectedBranch,
		);
	}

	return result(
		"ok",
		"Planner git state matches the repository.",
		currentBranch,
		expectedBranch,
	);
}

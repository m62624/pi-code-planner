export type PlannerRuntimeMode =
	| "idle"
	| "plan_active"
	| "operation_in_progress"
	| "recovery_required";

export type PlannerGitOperationType =
	| "init"
	| "create_branch"
	| "switch_branch"
	| "commit"
	| "merge"
	| "delete_branch"
	| "soft_reset"
	| "hard_reset";

export type PlannerBranchKind = "base" | "plan" | "child" | "experiment";

export type PlannerBranchStatus =
	| "active"
	| "merged"
	| "abandoned"
	| "selected"
	| "rejected"
	| "deleted";

export interface PlannerGitPosition {
	branch: string | null;
	commit: string | null;
}

export interface PendingPlannerGitOperation {
	id: string;
	type: PlannerGitOperationType;
	startedAt: string;
	before: PlannerGitPosition;
	expectedAfter: PlannerGitPosition | null;
}

export type PlannerCompactReason =
	| "discovery"
	| "work_item"
	| "refactor"
	| "manual";

export type PlannerCompactStatus = "requested" | "completed" | "failed";

export interface PendingPlannerCompact {
	id: string;
	reason: PlannerCompactReason;
	status: PlannerCompactStatus;
	requestedAt: string;
	completedAt: string | null;
	failedAt: string | null;
	error: string | null;
	activePlanId: string | null;
	activeWorkItemId: string | null;
	customInstructions: string;
	resumePrompt: string;
	attachToNextTurn: boolean;
	autoResume: boolean;
}

export interface PlannerBranchRecord {
	name: string;
	kind: PlannerBranchKind;
	planId: string | null;
	workItemId: string | null;
	createdFromCommit: string | null;
	lastKnownCommit: string | null;
	status: PlannerBranchStatus;
}

export interface PlannerBranchRegistry {
	baseBranch: string | null;
	planBranch: string | null;
	items: Record<string, PlannerBranchRecord>;
}

export interface PlannerGitState {
	baseBranch: string | null;
	planBranch: string | null;
	expectedBranch: string | null;
	expectedCommit: string | null;
	lastObservedCommit: string | null;
}

export interface PlannerRuntimeState {
	version: 1;
	mode: PlannerRuntimeMode;
	activePlanId: string | null;
	activeWorkItemId: string | null;
	git: PlannerGitState;
	pendingOperation: PendingPlannerGitOperation | null;
	pendingCompact: PendingPlannerCompact | null;
	branches: PlannerBranchRegistry;
}

export const DEFAULT_PLANNER_RUNTIME_STATE: PlannerRuntimeState = {
	version: 1,
	mode: "idle",
	activePlanId: null,
	activeWorkItemId: null,
	git: {
		baseBranch: null,
		planBranch: null,
		expectedBranch: null,
		expectedCommit: null,
		lastObservedCommit: null,
	},
	pendingOperation: null,
	pendingCompact: null,
	branches: {
		baseBranch: null,
		planBranch: null,
		items: {},
	},
};

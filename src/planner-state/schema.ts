export interface PlannerGitState {
	baseBranch: string | null;
	planBranch: string | null;
	expectedBranch: string | null;
	expectedCommit: string | null;
	lastObservedCommit: string | null;
}

export interface PlannerRuntimeState {
	version: 1;
	activePlanId: string | null;
	activeWorkItemId: string | null;
	git: PlannerGitState;
}

export const DEFAULT_PLANNER_RUNTIME_STATE: PlannerRuntimeState = {
	version: 1,
	activePlanId: null,
	activeWorkItemId: null,
	git: {
		baseBranch: null,
		planBranch: null,
		expectedBranch: null,
		expectedCommit: null,
		lastObservedCommit: null,
	},
};

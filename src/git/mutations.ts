import type { RuntimeStateManager } from "../planner-state/runtime";
import type {
	PendingPlannerGitOperation,
	PlannerBranchRecord,
	PlannerRuntimeState,
} from "../planner-state/schema";
import type { BranchNamingSettings } from "../settings/schema";
import { renderBranchName } from "./branch-naming";
import { checkGitPolicy, type GitPolicyDecision } from "./policy";
import type { RepoState } from "./state";
import type { GitWriter, MergeBranchOptions } from "./write";

export interface GitMutationsDeps {
	state: RuntimeStateManager;
	writer: GitWriter;
	branchNaming: BranchNamingSettings;
	readRepoState: () => Promise<RepoState>;
	now?: () => string;
	createOperationId?: () => string;
}

export interface GitMutationResult {
	before: RepoState;
	after: RepoState;
	state: PlannerRuntimeState;
}

export interface CreatePlanBranchInput {
	planId: string;
	startPoint?: string;
}

export interface CreateChildBranchInput {
	workItemId: string;
	startPoint?: string;
}

export interface CreateExperimentBranchInput {
	workItemId: string;
	attemptId: string;
	startPoint?: string;
}

export interface SelectExperimentBranchInput {
	workItemId: string;
	attemptId: string;
}

export interface CommitWorkItemInput {
	message: string;
	stageAll?: boolean;
	finalizeWorkItem?: boolean;
}

export interface SwitchBranchInput {
	targetBranch: string;
}

export interface SwitchToPlanBranchInput {
	planId?: string;
}

export interface SwitchToChildBranchInput {
	workItemId: string;
}

export interface SwitchToExperimentBranchInput {
	workItemId: string;
	attemptId: string;
}

export interface MergeBranchInput extends MergeBranchOptions {
	targetBranch: string;
}

export interface MergeExperimentBranchInput extends MergeBranchOptions {
	workItemId: string;
	attemptId: string;
}

export interface DeleteBranchInput {
	branchName: string;
	force?: boolean;
}

export interface DeleteChildBranchInput {
	workItemId: string;
	force?: boolean;
}

export interface DeleteExperimentBranchInput {
	workItemId: string;
	attemptId: string;
	force?: boolean;
}

export interface HardResetToExpectedInput {
	confirm: true;
}

export class GitMutationRejected extends Error {
	constructor(public decision: GitPolicyDecision) {
		super(decision.message);
	}
}

function ensureAllowed(decision: GitPolicyDecision): void {
	if (decision.kind !== "allow") {
		throw new GitMutationRejected(decision);
	}
}

function positionFromRepo(repoState: RepoState) {
	return {
		branch: repoState.currentBranch,
		commit: repoState.currentCommit,
	};
}

function upsertBranch(
	state: PlannerRuntimeState,
	branch: PlannerBranchRecord,
): PlannerRuntimeState {
	return {
		...state,
		branches: {
			...state.branches,
			items: {
				...state.branches.items,
				[branch.name]: branch,
			},
		},
	};
}

function managedExperimentBranchesForWorkItem(
	state: PlannerRuntimeState,
	planId: string,
	workItemId: string,
): PlannerBranchRecord[] {
	return Object.values(state.branches.items).filter(
		(branch) =>
			branch.kind === "experiment" &&
			branch.planId === planId &&
			branch.workItemId === workItemId &&
			branch.status !== "deleted",
	);
}

export class GitMutations {
	private operationCounter = 0;

	constructor(private deps: GitMutationsDeps) {}

	async createPlanBranch(
		input: CreatePlanBranchInput,
	): Promise<GitMutationResult> {
		const before = await this.deps.readRepoState();
		const state = this.loadState();
		const branchName = this.branchName("plan", {
			planId: input.planId,
		});
		ensureAllowed(
			checkGitPolicy({
				operation: "start_plan",
				repoState: before,
				plannerState: state,
			}),
		);

		this.beginOperation(state, before, "create_branch", {
			branch: branchName,
			commit: before.currentCommit,
		});
		await this.deps.writer.createAndSwitchBranch(branchName, input.startPoint);
		const after = await this.deps.readRepoState();

		const next = this.finishOperation(
			{
				...state,
				mode: "plan_active",
				activePlanId: input.planId,
				activeWorkItemId: null,
				git: {
					baseBranch: before.currentBranch,
					planBranch: branchName,
					expectedBranch: after.currentBranch,
					expectedCommit: after.currentCommit,
					lastObservedCommit: after.currentCommit,
				},
				branches: {
					baseBranch: before.currentBranch,
					planBranch: branchName,
					items: {},
				},
			},
			after,
		);

		const withBase = before.currentBranch
			? upsertBranch(next, {
					name: before.currentBranch,
					kind: "base",
					planId: null,
					workItemId: null,
					createdFromCommit: null,
					lastKnownCommit: before.currentCommit,
					status: "active",
				})
			: next;
		const withPlan = upsertBranch(withBase, {
			name: branchName,
			kind: "plan",
			planId: input.planId,
			workItemId: null,
			createdFromCommit: before.currentCommit,
			lastKnownCommit: after.currentCommit,
			status: "active",
		});
		this.saveState(withPlan);

		return { before, after, state: withPlan };
	}

	async initializeRepo(): Promise<GitMutationResult> {
		const before = await this.deps.readRepoState();
		const state = this.loadState();

		this.beginOperation(state, before, "init", null);
		await this.deps.writer.initRepo();
		const after = await this.deps.readRepoState();
		const next = this.finishOperation(
			{
				...state,
				mode: state.activePlanId ? "plan_active" : "idle",
				git: {
					...state.git,
					expectedBranch: after.currentBranch,
					expectedCommit: after.currentCommit,
					lastObservedCommit: after.currentCommit,
				},
			},
			after,
		);
		this.saveState(next);

		return { before, after, state: next };
	}

	async acceptCurrentGitState(): Promise<GitMutationResult> {
		const before = await this.deps.readRepoState();
		const state = this.loadState();
		const next = this.finishOperation(state, before);
		this.saveState(next);

		return { before, after: before, state: next };
	}

	async softResetToExpected(): Promise<GitMutationResult> {
		const before = await this.deps.readRepoState();
		const state = this.loadState();
		if (!state.git.expectedCommit) {
			throw new Error("Cannot soft reset without expected commit.");
		}

		this.beginOperation(state, before, "soft_reset", {
			branch: state.git.expectedBranch,
			commit: state.git.expectedCommit,
		});
		await this.deps.writer.softReset(state.git.expectedCommit);
		const after = await this.deps.readRepoState();
		const next = this.finishOperation(state, after);
		this.saveState(next);

		return { before, after, state: next };
	}

	async hardResetToExpected(
		input: HardResetToExpectedInput,
	): Promise<GitMutationResult> {
		if (input.confirm !== true) {
			throw new Error("Hard reset requires explicit confirmation.");
		}
		const before = await this.deps.readRepoState();
		const state = this.loadState();
		if (!state.git.expectedCommit) {
			throw new Error("Cannot hard reset without expected commit.");
		}

		this.beginOperation(state, before, "hard_reset", {
			branch: state.git.expectedBranch,
			commit: state.git.expectedCommit,
		});
		await this.deps.writer.hardReset(state.git.expectedCommit);
		const after = await this.deps.readRepoState();
		const next = this.finishOperation(state, after);
		this.saveState(next);

		return { before, after, state: next };
	}

	async createChildBranch(
		input: CreateChildBranchInput,
	): Promise<GitMutationResult> {
		const before = await this.deps.readRepoState();
		const state = this.loadState();
		if (!state.activePlanId) {
			throw new Error("Cannot create child branch without active plan id.");
		}
		const branchName = this.branchName("child", {
			planId: state.activePlanId,
			workItemId: input.workItemId,
		});
		ensureAllowed(
			checkGitPolicy({
				operation: "start_work_item",
				repoState: before,
				plannerState: state,
			}),
		);

		this.beginOperation(state, before, "create_branch", {
			branch: branchName,
			commit: before.currentCommit,
		});
		await this.deps.writer.createAndSwitchBranch(branchName, input.startPoint);
		const after = await this.deps.readRepoState();
		const next = upsertBranch(this.finishOperation(state, after), {
			name: branchName,
			kind: "child",
			planId: state.activePlanId,
			workItemId: input.workItemId,
			createdFromCommit: before.currentCommit,
			lastKnownCommit: after.currentCommit,
			status: "active",
		});
		const saved = {
			...next,
			activeWorkItemId: input.workItemId,
		};
		this.saveState(saved);

		return { before, after, state: saved };
	}

	async createExperimentBranch(
		input: CreateExperimentBranchInput,
	): Promise<GitMutationResult> {
		const before = await this.deps.readRepoState();
		const state = this.loadState();
		if (!state.activePlanId) {
			throw new Error(
				"Cannot create experiment branch without active plan id.",
			);
		}
		const branchName = this.branchName("experiment", {
			planId: state.activePlanId,
			workItemId: input.workItemId,
			attemptId: input.attemptId,
		});
		ensureAllowed(
			checkGitPolicy({
				operation: "start_work_item",
				repoState: before,
				plannerState: state,
			}),
		);

		this.beginOperation(state, before, "create_branch", {
			branch: branchName,
			commit: before.currentCommit,
		});
		await this.deps.writer.createAndSwitchBranch(branchName, input.startPoint);
		const after = await this.deps.readRepoState();
		const next = upsertBranch(this.finishOperation(state, after), {
			name: branchName,
			kind: "experiment",
			planId: state.activePlanId,
			workItemId: input.workItemId,
			createdFromCommit: before.currentCommit,
			lastKnownCommit: after.currentCommit,
			status: "active",
		});
		const saved = {
			...next,
			activeWorkItemId: input.workItemId,
		};
		this.saveState(saved);

		return { before, after, state: saved };
	}

	async selectExperimentBranch(
		input: SelectExperimentBranchInput,
	): Promise<GitMutationResult> {
		const before = await this.deps.readRepoState();
		const state = this.loadState();
		if (!state.activePlanId) {
			throw new Error("Cannot select experiment without active plan id.");
		}
		const activePlanId = state.activePlanId;
		const experimentBranch = this.branchName("experiment", {
			planId: state.activePlanId,
			workItemId: input.workItemId,
			attemptId: input.attemptId,
		});
		const targetBranch = this.branchName("child", {
			planId: state.activePlanId,
			workItemId: input.workItemId,
		});
		const experiment = state.branches.items[experimentBranch];
		if (!experiment || experiment.kind !== "experiment") {
			throw new Error("Selected branch is not a registered experiment branch.");
		}
		const target = state.branches.items[targetBranch];
		if (!target || target.kind !== "child") {
			throw new Error("Experiment target is not a registered child branch.");
		}

		// Commit uncommitted changes on the experiment branch before switching.
		// The agent may have edited files via the edit tool without committing.
		if (before.status.isDirty) {
			await this.deps.writer.stageAll();
			await this.deps.writer.commit(
				`planner: auto-commit experiment changes for ${input.attemptId}`,
			);
			const postCommit = await this.deps.readRepoState();
			const updatedState = {
				...state,
				branches: {
					...state.branches,
					items: {
						...state.branches.items,
						[experimentBranch]: {
							...state.branches.items[experimentBranch],
							lastKnownCommit: postCommit.currentCommit,
						},
					},
				},
			};
			this.saveState(updatedState);
			// Re-read repo state after commit so policy check sees clean worktree
			const cleanedState = await this.deps.readRepoState();
			before.status = cleanedState.status;
		}

		ensureAllowed(
			checkGitPolicy({
				operation: "switch_branch",
				repoState: before,
				plannerState: state,
				targetBranch,
			}),
		);

		this.beginOperation(state, before, "switch_branch", {
			branch: targetBranch,
			commit: null,
		});
		await this.deps.writer.switchBranch(targetBranch);
		const afterSwitch = await this.deps.readRepoState();
		const switchedState = this.finishOperation(state, afterSwitch);
		this.saveState(switchedState);

		const mergeResult = await this.mergeBranchByName({
			targetBranch: experimentBranch,
			noFastForward: true,
		});
		const mergedState = this.loadState();
		const selectedState = {
			...mergedState,
			branches: {
				...mergedState.branches,
				items: {
					...mergedState.branches.items,
					[experimentBranch]: {
						...experiment,
						status: "selected" as const,
						lastKnownCommit: mergeResult.after.currentCommit,
					},
					[targetBranch]: {
						...target,
						status: "active" as const,
						lastKnownCommit: mergeResult.after.currentCommit,
					},
				},
			},
		};
		this.saveState(selectedState);

		let cleanupState = selectedState;
		for (const branch of managedExperimentBranchesForWorkItem(
			selectedState,
			activePlanId,
			input.workItemId,
		)) {
			const deleted = await this.deleteBranchByName({
				branchName: branch.name,
				force: true,
			});
			cleanupState = deleted.state;
		}

		return {
			before,
			after: mergeResult.after,
			state: cleanupState,
		};
	}

	async commitWorkItem(input: CommitWorkItemInput): Promise<GitMutationResult> {
		const before = await this.deps.readRepoState();
		const state = this.loadState();
		ensureAllowed(
			checkGitPolicy({
				operation: "finish_work_item",
				repoState: before,
				plannerState: state,
			}),
		);

		this.beginOperation(state, before, "commit", null);
		if (input.stageAll ?? true) {
			await this.deps.writer.stageAll();
		}
		await this.deps.writer.commit(input.message);
		const after = await this.deps.readRepoState();
		const next = this.finishOperation(state, after);
		this.saveState(next);

		if (!input.finalizeWorkItem) {
			return { before, after, state: next };
		}

		const activePlanId = next.activePlanId;
		const activeWorkItemId = next.activeWorkItemId;
		if (!activePlanId || !activeWorkItemId) {
			throw new Error(
				"Cannot finalize work item without active plan and item.",
			);
		}
		const childBranch = this.branchName("child", {
			planId: activePlanId,
			workItemId: activeWorkItemId,
		});
		const planBranch = this.branchName("plan", {
			planId: activePlanId,
		});

		await this.switchBranchByName({ targetBranch: planBranch });
		const mergeResult = await this.mergeBranchByName({
			targetBranch: childBranch,
			noFastForward: true,
		});
		const mergedState = this.loadState();
		this.saveState({
			...mergedState,
			branches: {
				...mergedState.branches,
				items: {
					...mergedState.branches.items,
					[childBranch]: {
						...mergedState.branches.items[childBranch],
						status: "merged",
						lastKnownCommit: mergeResult.after.currentCommit,
					},
					[planBranch]: {
						...mergedState.branches.items[planBranch],
						status: "active",
						lastKnownCommit: mergeResult.after.currentCommit,
					},
				},
			},
		});
		const deleted = await this.deleteBranchByName({
			branchName: childBranch,
			force: true,
		});

		return { before, after: deleted.after, state: deleted.state };
	}

	async switchToPlanBranch(
		input: SwitchToPlanBranchInput = {},
	): Promise<GitMutationResult> {
		const state = this.loadState();
		const planId = input.planId ?? state.activePlanId;
		if (!planId) {
			throw new Error("Cannot switch to plan branch without plan id.");
		}
		return this.switchBranchByName({
			targetBranch: this.branchName("plan", { planId }),
		});
	}

	async switchToChildBranch(
		input: SwitchToChildBranchInput,
	): Promise<GitMutationResult> {
		const state = this.loadState();
		if (!state.activePlanId) {
			throw new Error("Cannot switch to child branch without active plan id.");
		}
		return this.switchBranchByName({
			targetBranch: this.branchName("child", {
				planId: state.activePlanId,
				workItemId: input.workItemId,
			}),
		});
	}

	async switchToExperimentBranch(
		input: SwitchToExperimentBranchInput,
	): Promise<GitMutationResult> {
		const state = this.loadState();
		if (!state.activePlanId) {
			throw new Error(
				"Cannot switch to experiment branch without active plan id.",
			);
		}
		return this.switchBranchByName({
			targetBranch: this.branchName("experiment", {
				planId: state.activePlanId,
				workItemId: input.workItemId,
				attemptId: input.attemptId,
			}),
		});
	}

	private async switchBranchByName(
		input: SwitchBranchInput,
	): Promise<GitMutationResult> {
		const before = await this.deps.readRepoState();
		const state = this.loadState();
		ensureAllowed(
			checkGitPolicy({
				operation: "switch_branch",
				repoState: before,
				plannerState: state,
				targetBranch: input.targetBranch,
			}),
		);

		this.beginOperation(state, before, "switch_branch", {
			branch: input.targetBranch,
			commit: null,
		});
		await this.deps.writer.switchBranch(input.targetBranch);
		const after = await this.deps.readRepoState();
		const next = this.finishOperation(state, after);
		this.saveState(next);

		return { before, after, state: next };
	}

	async mergeExperimentBranch(
		input: MergeExperimentBranchInput,
	): Promise<GitMutationResult> {
		const state = this.loadState();
		if (!state.activePlanId) {
			throw new Error("Cannot merge experiment branch without active plan id.");
		}
		return this.mergeBranchByName({
			targetBranch: this.branchName("experiment", {
				planId: state.activePlanId,
				workItemId: input.workItemId,
				attemptId: input.attemptId,
			}),
			noFastForward: input.noFastForward,
			message: input.message,
		});
	}

	private async mergeBranchByName(
		input: MergeBranchInput,
	): Promise<GitMutationResult> {
		const before = await this.deps.readRepoState();
		const state = this.loadState();
		ensureAllowed(
			checkGitPolicy({
				operation: "merge_branch",
				repoState: before,
				plannerState: state,
				targetBranch: input.targetBranch,
			}),
		);

		this.beginOperation(state, before, "merge", null);
		await this.deps.writer.mergeBranch(input.targetBranch, {
			noFastForward: input.noFastForward,
			message: input.message,
		});
		const after = await this.deps.readRepoState();
		const next = this.finishOperation(state, after);
		this.saveState(next);

		return { before, after, state: next };
	}

	async deleteChildBranch(
		input: DeleteChildBranchInput,
	): Promise<GitMutationResult> {
		const state = this.loadState();
		if (!state.activePlanId) {
			throw new Error("Cannot delete child branch without active plan id.");
		}
		return this.deleteBranchByName({
			branchName: this.branchName("child", {
				planId: state.activePlanId,
				workItemId: input.workItemId,
			}),
			force: input.force,
		});
	}

	async deleteExperimentBranch(
		input: DeleteExperimentBranchInput,
	): Promise<GitMutationResult> {
		const state = this.loadState();
		if (!state.activePlanId) {
			throw new Error(
				"Cannot delete experiment branch without active plan id.",
			);
		}
		return this.deleteBranchByName({
			branchName: this.branchName("experiment", {
				planId: state.activePlanId,
				workItemId: input.workItemId,
				attemptId: input.attemptId,
			}),
			force: input.force,
		});
	}

	private async deleteBranchByName(
		input: DeleteBranchInput,
	): Promise<GitMutationResult> {
		const before = await this.deps.readRepoState();
		const state = this.loadState();
		ensureAllowed(
			checkGitPolicy({
				operation: "delete_branch",
				repoState: before,
				plannerState: state,
				branchName: input.branchName,
			}),
		);

		this.beginOperation(state, before, "delete_branch", null);
		await this.deps.writer.deleteBranch(input.branchName, {
			force: input.force,
		});
		const after = await this.deps.readRepoState();
		const next = this.finishOperation(
			{
				...state,
				branches: {
					...state.branches,
					items: {
						...state.branches.items,
						[input.branchName]: {
							...state.branches.items[input.branchName],
							status: "deleted",
							lastKnownCommit: after.currentCommit,
						},
					},
				},
			},
			after,
		);
		this.saveState(next);

		return { before, after, state: next };
	}

	private beginOperation(
		state: PlannerRuntimeState,
		before: RepoState,
		type: PendingPlannerGitOperation["type"],
		expectedAfter: PendingPlannerGitOperation["expectedAfter"],
	): void {
		this.saveState({
			...state,
			mode: "operation_in_progress",
			pendingOperation: {
				id: this.createOperationId(),
				type,
				startedAt: this.now(),
				before: positionFromRepo(before),
				expectedAfter,
			},
		});
	}

	private finishOperation(
		state: PlannerRuntimeState,
		after: RepoState,
	): PlannerRuntimeState {
		return {
			...state,
			mode: state.activePlanId ? "plan_active" : "idle",
			pendingOperation: null,
			git: {
				...state.git,
				expectedBranch: after.currentBranch,
				expectedCommit: after.currentCommit,
				lastObservedCommit: after.currentCommit,
			},
		};
	}

	private loadState(): PlannerRuntimeState {
		return this.deps.state.get();
	}

	private saveState(state: PlannerRuntimeState): void {
		this.deps.state.replace(state);
	}

	private branchName(
		kind: "plan" | "child" | "experiment",
		values: Parameters<typeof renderBranchName>[2],
	): string {
		return renderBranchName(this.deps.branchNaming, kind, values);
	}

	private now(): string {
		return this.deps.now?.() ?? new Date().toISOString();
	}

	private createOperationId(): string {
		if (this.deps.createOperationId) return this.deps.createOperationId();
		this.operationCounter += 1;
		return `git-op-${this.operationCounter}`;
	}
}

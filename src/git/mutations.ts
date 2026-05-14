import type { RuntimeStateManager } from "../planner-state/runtime";
import type {
	PendingPlannerGitOperation,
	PlannerBranchRecord,
	PlannerRuntimeState,
} from "../planner-state/schema";
import { checkGitPolicy, type GitPolicyDecision } from "./policy";
import type { RepoState } from "./state";
import type { GitWriter, MergeBranchOptions } from "./write";

export interface GitMutationsDeps {
	state: RuntimeStateManager;
	writer: GitWriter;
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
	branchName: string;
	startPoint?: string;
}

export interface CreateChildBranchInput {
	workItemId: string;
	branchName: string;
	startPoint?: string;
}

export interface CreateExperimentBranchInput {
	workItemId: string;
	branchName: string;
	startPoint?: string;
}

export interface SelectExperimentBranchInput {
	branchName: string;
	targetBranch: string;
}

export interface CommitWorkItemInput {
	message: string;
	stageAll?: boolean;
}

export interface SwitchBranchInput {
	targetBranch: string;
}

export interface MergeBranchInput extends MergeBranchOptions {
	targetBranch: string;
}

export interface DeleteBranchInput {
	branchName: string;
	force?: boolean;
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

export class GitMutations {
	private operationCounter = 0;

	constructor(private deps: GitMutationsDeps) {}

	async createPlanBranch(
		input: CreatePlanBranchInput,
	): Promise<GitMutationResult> {
		const before = await this.deps.readRepoState();
		const state = this.loadState();
		ensureAllowed(
			checkGitPolicy({
				operation: "start_plan",
				repoState: before,
				plannerState: state,
			}),
		);

		this.beginOperation(state, before, "create_branch", {
			branch: input.branchName,
			commit: before.currentCommit,
		});
		await this.deps.writer.createAndSwitchBranch(
			input.branchName,
			input.startPoint,
		);
		const after = await this.deps.readRepoState();

		const next = this.finishOperation(
			{
				...state,
				mode: "plan_active",
				activePlanId: input.planId,
				activeWorkItemId: null,
				git: {
					baseBranch: before.currentBranch,
					planBranch: input.branchName,
					expectedBranch: after.currentBranch,
					expectedCommit: after.currentCommit,
					lastObservedCommit: after.currentCommit,
				},
				branches: {
					baseBranch: before.currentBranch,
					planBranch: input.branchName,
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
			name: input.branchName,
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

	async createChildBranch(
		input: CreateChildBranchInput,
	): Promise<GitMutationResult> {
		const before = await this.deps.readRepoState();
		const state = this.loadState();
		ensureAllowed(
			checkGitPolicy({
				operation: "start_work_item",
				repoState: before,
				plannerState: state,
			}),
		);

		this.beginOperation(state, before, "create_branch", {
			branch: input.branchName,
			commit: before.currentCommit,
		});
		await this.deps.writer.createAndSwitchBranch(
			input.branchName,
			input.startPoint,
		);
		const after = await this.deps.readRepoState();
		const next = upsertBranch(this.finishOperation(state, after), {
			name: input.branchName,
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
		ensureAllowed(
			checkGitPolicy({
				operation: "start_work_item",
				repoState: before,
				plannerState: state,
			}),
		);

		this.beginOperation(state, before, "create_branch", {
			branch: input.branchName,
			commit: before.currentCommit,
		});
		await this.deps.writer.createAndSwitchBranch(
			input.branchName,
			input.startPoint,
		);
		const after = await this.deps.readRepoState();
		const next = upsertBranch(this.finishOperation(state, after), {
			name: input.branchName,
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
		const experiment = state.branches.items[input.branchName];
		if (!experiment || experiment.kind !== "experiment") {
			throw new Error("Selected branch is not a registered experiment branch.");
		}
		const target = state.branches.items[input.targetBranch];
		if (!target || target.kind !== "child") {
			throw new Error("Experiment target is not a registered child branch.");
		}

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
		const afterSwitch = await this.deps.readRepoState();
		const switchedState = this.finishOperation(state, afterSwitch);
		this.saveState(switchedState);

		const mergeResult = await this.mergeBranch({
			targetBranch: input.branchName,
			noFastForward: true,
		});
		const mergedState = this.loadState();
		const selectedState = {
			...mergedState,
			branches: {
				...mergedState.branches,
				items: {
					...mergedState.branches.items,
					[input.branchName]: {
						...experiment,
						status: "selected" as const,
						lastKnownCommit: mergeResult.after.currentCommit,
					},
					[input.targetBranch]: {
						...target,
						status: "active" as const,
						lastKnownCommit: mergeResult.after.currentCommit,
					},
				},
			},
		};
		this.saveState(selectedState);

		return {
			before,
			after: mergeResult.after,
			state: selectedState,
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

		return { before, after, state: next };
	}

	async switchBranch(input: SwitchBranchInput): Promise<GitMutationResult> {
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

	async mergeBranch(input: MergeBranchInput): Promise<GitMutationResult> {
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

	async deleteBranch(input: DeleteBranchInput): Promise<GitMutationResult> {
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

	private now(): string {
		return this.deps.now?.() ?? new Date().toISOString();
	}

	private createOperationId(): string {
		if (this.deps.createOperationId) return this.deps.createOperationId();
		this.operationCounter += 1;
		return `git-op-${this.operationCounter}`;
	}
}

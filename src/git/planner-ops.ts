import type { PlanStateRecord } from "../storage/schema";
import {
	experimentBranchName,
	outputBranchName,
	refactorBranchName,
	taskBranchName,
} from "./branches";
import type { GitRunner } from "./runner";

export interface PlannerGitOperationResult {
	state: PlanStateRecord;
}

export async function createAndSwitchTaskBranch(input: {
	git: GitRunner;
	state: PlanStateRecord;
	planId: string;
	taskId: string;
}): Promise<PlannerGitOperationResult> {
	const worktreePath = requireWorktreePath(input.state);
	const branch = taskBranchName(input.planId, input.taskId);
	await input.git.createBranch({
		repoRoot: worktreePath,
		branch,
		fromRef: input.state.branches.plan,
	});
	await input.git.switchBranch({ repoRoot: worktreePath, branch });

	return {
		state: {
			...input.state,
			activeTaskId: input.taskId,
			activeExperimentId: null,
			branches: {
				...input.state.branches,
				currentTask: branch,
				currentExperiment: null,
				selectedExperiment: null,
			},
			currentBranch: branch,
			mergeTargets: {
				...input.state.mergeTargets,
				taskToPlan: input.state.branches.plan,
				experimentToTask: null,
			},
		},
	};
}

export async function createAndSwitchExperimentBranch(input: {
	git: GitRunner;
	state: PlanStateRecord;
	planId: string;
	taskId: string;
	attemptId: string;
}): Promise<PlannerGitOperationResult> {
	const worktreePath = requireWorktreePath(input.state);
	const taskBranch = requireCurrentTaskBranch(input.state);
	const branch = experimentBranchName(
		input.planId,
		input.taskId,
		input.attemptId,
	);
	await input.git.createBranch({
		repoRoot: worktreePath,
		branch,
		fromRef: taskBranch,
	});
	await input.git.switchBranch({ repoRoot: worktreePath, branch });

	return {
		state: {
			...input.state,
			activeTaskId: input.taskId,
			activeExperimentId: input.attemptId,
			branches: {
				...input.state.branches,
				currentExperiment: branch,
			},
			currentBranch: branch,
			mergeTargets: {
				...input.state.mergeTargets,
				experimentToTask: taskBranch,
			},
		},
	};
}

export async function selectExperiment(input: {
	state: PlanStateRecord;
	planId: string;
	taskId: string;
	attemptId: string;
}): Promise<PlannerGitOperationResult> {
	const selectedExperiment = experimentBranchName(
		input.planId,
		input.taskId,
		input.attemptId,
	);
	return {
		state: {
			...input.state,
			activeExperimentId: input.attemptId,
			branches: {
				...input.state.branches,
				selectedExperiment,
			},
		},
	};
}

export async function mergeSelectedExperimentToTask(input: {
	git: GitRunner;
	state: PlanStateRecord;
	message: string;
}): Promise<PlannerGitOperationResult> {
	const worktreePath = requireWorktreePath(input.state);
	const taskBranch = requireCurrentTaskBranch(input.state);
	const selectedExperiment = requireSelectedExperimentBranch(input.state);
	await input.git.switchBranch({ repoRoot: worktreePath, branch: taskBranch });
	await input.git.merge({
		repoRoot: worktreePath,
		sourceBranch: selectedExperiment,
		noFastForward: true,
		message: input.message,
	});

	return {
		state: {
			...input.state,
			currentBranch: taskBranch,
			branches: {
				...input.state.branches,
				currentExperiment: null,
			},
			mergeTargets: {
				...input.state.mergeTargets,
				experimentToTask: null,
			},
		},
	};
}

export async function createAndSwitchRefactorBranch(input: {
	git: GitRunner;
	state: PlanStateRecord;
	planId: string;
	taskId: string;
}): Promise<PlannerGitOperationResult> {
	const worktreePath = requireWorktreePath(input.state);
	const taskBranch = requireCurrentTaskBranch(input.state);
	const branch = refactorBranchName(input.planId, input.taskId);
	await input.git.createBranch({
		repoRoot: worktreePath,
		branch,
		fromRef: taskBranch,
	});
	await input.git.switchBranch({ repoRoot: worktreePath, branch });
	return { state: { ...input.state, currentBranch: branch } };
}

export async function mergeRefactorToTask(input: {
	git: GitRunner;
	state: PlanStateRecord;
	planId: string;
	taskId: string;
	message: string;
}): Promise<PlannerGitOperationResult> {
	const worktreePath = requireWorktreePath(input.state);
	const taskBranch = requireCurrentTaskBranch(input.state);
	const refactorBranch = refactorBranchName(input.planId, input.taskId);
	await input.git.switchBranch({ repoRoot: worktreePath, branch: taskBranch });
	await input.git.merge({
		repoRoot: worktreePath,
		sourceBranch: refactorBranch,
		noFastForward: true,
		message: input.message,
	});
	return { state: { ...input.state, currentBranch: taskBranch } };
}

export async function mergeTaskToPlan(input: {
	git: GitRunner;
	state: PlanStateRecord;
	message: string;
}): Promise<PlannerGitOperationResult> {
	const worktreePath = requireWorktreePath(input.state);
	const taskBranch = requireCurrentTaskBranch(input.state);
	const planBranch = input.state.branches.plan;
	await input.git.switchBranch({ repoRoot: worktreePath, branch: planBranch });
	await input.git.merge({
		repoRoot: worktreePath,
		sourceBranch: taskBranch,
		noFastForward: true,
		message: input.message,
	});
	return {
		state: {
			...input.state,
			activeTaskId: null,
			activeExperimentId: null,
			currentBranch: planBranch,
			branches: {
				...input.state.branches,
				currentTask: null,
				currentExperiment: null,
				selectedExperiment: null,
			},
			mergeTargets: {
				...input.state.mergeTargets,
				taskToPlan: null,
				experimentToTask: null,
			},
		},
	};
}

export async function exportPlanToOutputBranch(input: {
	git: GitRunner;
	state: PlanStateRecord;
	projectRoot: string;
	planId: string;
	message: string;
}): Promise<PlannerGitOperationResult> {
	const outputBranch = outputBranchName(input.planId);
	await input.git.createBranch({
		repoRoot: input.projectRoot,
		branch: outputBranch,
		fromRef: input.state.branches.base,
	});
	await input.git.switchBranch({
		repoRoot: input.projectRoot,
		branch: outputBranch,
	});
	await input.git.merge({
		repoRoot: input.projectRoot,
		sourceBranch: input.state.branches.plan,
		noFastForward: true,
		message: input.message,
	});
	return {
		state: {
			...input.state,
			mergeTargets: {
				...input.state.mergeTargets,
				planToOutput: outputBranch,
			},
		},
	};
}

export async function deleteManagedBranch(input: {
	git: GitRunner;
	repoRoot: string;
	branch: string;
	force?: boolean;
}): Promise<void> {
	if (input.branch.startsWith("plan/")) {
		throw new Error(
			"Plan branch is protected and cannot be deleted by deleteManagedBranch.",
		);
	}
	await input.git.deleteBranch({
		repoRoot: input.repoRoot,
		branch: input.branch,
		force: input.force ?? false,
	});
}

function requireWorktreePath(state: PlanStateRecord): string {
	if (!state.worktreePath) {
		throw new Error("Plan state has no worktreePath.");
	}
	return state.worktreePath;
}

function requireCurrentTaskBranch(state: PlanStateRecord): string {
	if (!state.branches.currentTask) {
		throw new Error("Plan state has no current task branch.");
	}
	return state.branches.currentTask;
}

function requireSelectedExperimentBranch(state: PlanStateRecord): string {
	if (!state.branches.selectedExperiment) {
		throw new Error("Plan state has no selected experiment branch.");
	}
	return state.branches.selectedExperiment;
}

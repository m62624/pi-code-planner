import type {
	ManagedTaskBranchRegistry,
	PlanStateRecord,
} from "../storage/schema";
import {
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
		fromRef: input.state.activeBranches.plan,
	});
	await input.git.switchBranch({ repoRoot: worktreePath, branch });

	return {
		state: {
			...withTaskBranchRegistry(input.state, input.taskId, (registry) => ({
				...registry,
				task: branch,
			})),
			activeTaskId: input.taskId,
			activeBranches: {
				...input.state.activeBranches,
				currentTask: branch,
			},
			currentBranch: branch,
			mergeTargets: {
				...input.state.mergeTargets,
				taskToPlan: input.state.activeBranches.plan,
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
	return {
		state: {
			...withTaskBranchRegistry(input.state, input.taskId, (registry) => ({
				...registry,
				refactor: branch,
			})),
			currentBranch: branch,
		},
	};
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
	await deleteManagedBranch({
		git: input.git,
		repoRoot: worktreePath,
		branch: refactorBranch,
		force: false,
	});
	return {
		state: {
			...withTaskBranchRegistry(input.state, input.taskId, (registry) => ({
				...registry,
				refactor: null,
			})),
			currentBranch: taskBranch,
		},
	};
}

export async function mergeTaskToPlan(input: {
	git: GitRunner;
	state: PlanStateRecord;
	message: string;
}): Promise<PlannerGitOperationResult> {
	const worktreePath = requireWorktreePath(input.state);
	const taskId = requireActiveTaskId(input.state);
	const taskBranch = requireCurrentTaskBranch(input.state);
	const planBranch = input.state.activeBranches.plan;
	const registry = getTaskBranchRegistry(input.state, taskId);
	await input.git.switchBranch({ repoRoot: worktreePath, branch: planBranch });
	await input.git.merge({
		repoRoot: worktreePath,
		sourceBranch: taskBranch,
		noFastForward: true,
		message: input.message,
	});
	for (const branch of uniqueBranches([registry.refactor])) {
		await deleteManagedBranch({
			git: input.git,
			repoRoot: worktreePath,
			branch,
			force: true,
		});
	}
	await deleteManagedBranch({
		git: input.git,
		repoRoot: worktreePath,
		branch: taskBranch,
		force: false,
	});
	return {
		state: {
			...removeTaskBranchRegistry(input.state, taskId),
			activeTaskId: null,
			currentBranch: planBranch,
			activeBranches: {
				...input.state.activeBranches,
				currentTask: null,
			},
			mergeTargets: {
				...input.state.mergeTargets,
				taskToPlan: null,
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
		fromRef: input.state.activeBranches.base,
	});
	await input.git.switchBranch({
		repoRoot: input.projectRoot,
		branch: outputBranch,
	});
	await input.git.merge({
		repoRoot: input.projectRoot,
		sourceBranch: input.state.activeBranches.plan,
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
	if (!state.activeBranches.currentTask) {
		throw new Error("Plan state has no current task branch.");
	}
	return state.activeBranches.currentTask;
}

function requireActiveTaskId(state: PlanStateRecord): string {
	if (!state.activeTaskId) {
		throw new Error("Plan state has no active task id.");
	}
	return state.activeTaskId;
}

function getTaskBranchRegistry(
	state: PlanStateRecord,
	taskId: string,
): ManagedTaskBranchRegistry {
	return (
		state.managedBranches.tasks[taskId] ?? {
			task: null,
			refactor: null,
		}
	);
}

function withTaskBranchRegistry(
	state: PlanStateRecord,
	taskId: string,
	update: (registry: ManagedTaskBranchRegistry) => ManagedTaskBranchRegistry,
): PlanStateRecord {
	return {
		...state,
		managedBranches: {
			...state.managedBranches,
			tasks: {
				...state.managedBranches.tasks,
				[taskId]: update(getTaskBranchRegistry(state, taskId)),
			},
		},
	};
}

function removeTaskBranchRegistry(
	state: PlanStateRecord,
	taskId: string,
): PlanStateRecord {
	const tasks = { ...state.managedBranches.tasks };
	delete tasks[taskId];
	return {
		...state,
		managedBranches: {
			...state.managedBranches,
			tasks,
		},
	};
}

function uniqueBranches(values: readonly (string | null)[]): string[] {
	return [
		...new Set(values.filter((value): value is string => value !== null)),
	];
}

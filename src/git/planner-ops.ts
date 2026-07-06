import type {
	ManagedTaskBranchRegistry,
	PlanStateRecord,
} from "../storage/schema";
import { requireWorktreePath } from "../storage/state-store";
import {
	outputBranchName,
	refactorBranchName,
	taskBranchName,
} from "./branches";
import type { GitRunner } from "./runner";

export interface PlannerGitOperationResult {
	state: PlanStateRecord;
}

export interface PlanExportConflictDetails {
	outputBranch: string;
	planBranch: string;
	baseBranch: string;
	conflictFiles: readonly string[];
	gitStderr: string;
}

/**
 * Raised when the final plan→output merge fails on a content conflict.
 *
 * By the time this is thrown the repository has already been rolled back:
 * the merge is aborted, the working copy is back on the base branch, and the
 * freshly created output branch is deleted. Nothing the planner manages (plan
 * branch, worktree, plan state) was touched — the user can resolve the
 * conflicting files and re-run /planner-finish to retry the export.
 */
export class PlanExportConflictError extends Error {
	constructor(public readonly details: PlanExportConflictDetails) {
		super(buildPlanExportConflictSummary(details));
		this.name = "PlanExportConflictError";
	}
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
	// Same atomicity guard as mergeTaskToPlan: state still records the refactor
	// branch as current until this returns, so a failed merge must put the
	// worktree back on the refactor branch instead of leaving it on the task
	// branch (which would diverge from state and trip wrong_branch recovery).
	await input.git.switchBranch({ repoRoot: worktreePath, branch: taskBranch });
	try {
		await input.git.merge({
			repoRoot: worktreePath,
			sourceBranch: refactorBranch,
			noFastForward: true,
			message: input.message,
		});
	} catch (error) {
		await abortMergeAndRestoreBranch({
			git: input.git,
			repoRoot: worktreePath,
			restoreBranch: refactorBranch,
		});
		throw error;
	}
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
	// Switching to the plan branch is a real git side effect, but plan state is
	// only updated (currentBranch -> plan) on full success below. If the merge
	// throws mid-flight, git would sit on the plan branch while state still
	// records the task branch as current — recovery then flags wrong_branch and
	// deadlocks. Roll the worktree back to the task branch so git and state stay
	// consistent and the step is cleanly retryable.
	await input.git.switchBranch({ repoRoot: worktreePath, branch: planBranch });
	try {
		await input.git.merge({
			repoRoot: worktreePath,
			sourceBranch: taskBranch,
			noFastForward: true,
			message: input.message,
		});
	} catch (error) {
		await abortMergeAndRestoreBranch({
			git: input.git,
			repoRoot: worktreePath,
			restoreBranch: taskBranch,
		});
		throw error;
	}
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
	const baseBranch = input.state.activeBranches.base;
	const planBranch = input.state.activeBranches.plan;
	await input.git.createBranch({
		repoRoot: input.projectRoot,
		branch: outputBranch,
		fromRef: baseBranch,
	});
	await input.git.switchBranch({
		repoRoot: input.projectRoot,
		branch: outputBranch,
	});
	try {
		await input.git.merge({
			repoRoot: input.projectRoot,
			sourceBranch: planBranch,
			noFastForward: true,
			message: input.message,
		});
	} catch (error) {
		// A failed export merge leaves the original repository mid-merge on the
		// output branch with a conflicted index. Capture the conflicting files
		// first, then roll everything back so the repo is clean and the user can
		// re-run /planner-finish after reconciling the conflict.
		const conflictFiles = await collectExportConflictFiles(
			input.git,
			input.projectRoot,
		);
		await rollbackFailedExport({
			git: input.git,
			repoRoot: input.projectRoot,
			baseBranch,
			outputBranch,
		});
		throw new PlanExportConflictError({
			outputBranch,
			planBranch,
			baseBranch,
			conflictFiles,
			gitStderr: extractGitStderr(error),
		});
	}
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

async function collectExportConflictFiles(
	git: GitRunner,
	repoRoot: string,
): Promise<string[]> {
	try {
		const porcelain = await git.statusPorcelain({ repoRoot });
		return parseUnmergedFiles(porcelain);
	} catch {
		return [];
	}
}

/**
 * Parse `git status --porcelain=v1` output for unmerged (conflicted) paths.
 *
 * Unmerged entries are those whose staged/working states form one of the
 * conflict pairs: any side equal to `U`, or `AA` (both added) / `DD` (both
 * deleted).
 */
export function parseUnmergedFiles(porcelain: string): string[] {
	const files: string[] = [];
	for (const line of porcelain.split(/\r?\n/)) {
		if (line.length < 4) {
			continue;
		}
		const x = line[0];
		const y = line[1];
		const path = line.slice(3).trim();
		const unmerged =
			x === "U" ||
			y === "U" ||
			(x === "A" && y === "A") ||
			(x === "D" && y === "D");
		if (unmerged && path) {
			files.push(path);
		}
	}
	return files;
}

async function rollbackFailedExport(input: {
	git: GitRunner;
	repoRoot: string;
	baseBranch: string;
	outputBranch: string;
}): Promise<void> {
	// Best-effort: each step may legitimately be unnecessary (e.g. nothing to
	// abort), and a rollback failure must never mask the original conflict.
	await runSafely(() => input.git.mergeAbort({ repoRoot: input.repoRoot }));
	await runSafely(() =>
		input.git.switchBranch({
			repoRoot: input.repoRoot,
			branch: input.baseBranch,
		}),
	);
	await runSafely(() =>
		input.git.deleteBranch({
			repoRoot: input.repoRoot,
			branch: input.outputBranch,
			force: true,
		}),
	);
}

/**
 * Roll a worktree back after an in-worktree merge fails: abort the half-applied
 * merge and return to the branch the wrapper switched away from. Best-effort —
 * a rollback step that is unnecessary or itself fails must never mask the
 * original merge error, which the caller rethrows.
 */
async function abortMergeAndRestoreBranch(input: {
	git: GitRunner;
	repoRoot: string;
	restoreBranch: string;
}): Promise<void> {
	await runSafely(() => input.git.mergeAbort({ repoRoot: input.repoRoot }));
	await runSafely(() =>
		input.git.switchBranch({
			repoRoot: input.repoRoot,
			branch: input.restoreBranch,
		}),
	);
}

async function runSafely(action: () => Promise<void>): Promise<void> {
	try {
		await action();
	} catch {
		// Rollback is best-effort; swallow so the original error surfaces.
	}
}

function extractGitStderr(error: unknown): string {
	if (
		error &&
		typeof error === "object" &&
		"stderr" in error &&
		typeof (error as { stderr: unknown }).stderr === "string"
	) {
		return (error as { stderr: string }).stderr;
	}
	return "";
}

function buildPlanExportConflictSummary(
	details: PlanExportConflictDetails,
): string {
	const files =
		details.conflictFiles.length > 0
			? details.conflictFiles.join(", ")
			: "(git reported no specific files)";
	const lines = [
		`Merging ${details.planBranch} into ${details.outputBranch} hit a merge conflict; the export was rolled back and the repository is back on ${details.baseBranch}.`,
		`Conflicting files: ${files}.`,
	];
	const stderr = details.gitStderr.trim();
	if (stderr) {
		lines.push(stderr);
	}
	return lines.join("\n");
}

/**
 * Build the message handed to the model after a rolled-back export conflict.
 *
 * The model cannot resolve a real content conflict on its own, so this tells
 * it to summarize the failure for the user, make clear it needs the user to
 * reconcile the files, and that the user must re-run /planner-finish to retry.
 */
export function buildPlanExportConflictPrompt(
	error: PlanExportConflictError,
): string {
	const { outputBranch, planBranch, baseBranch, conflictFiles, gitStderr } =
		error.details;
	const fileLines =
		conflictFiles.length > 0
			? conflictFiles.map((file) => `- ${file}`)
			: ["- (git did not report specific files)"];
	const lines = [
		"Planner finish could not export the accepted plan: merging the plan branch into the output branch produced a Git merge conflict.",
		"",
		"The planner already rolled the repository back: the temporary output branch was deleted, the working copy is back on its base branch, and the plan branch, worktree, and planner state are all preserved. Nothing was lost and no cleanup happened.",
		"",
		`Base branch: ${baseBranch}`,
		`Plan branch: ${planBranch}`,
		`Output branch (rolled back, will be recreated on retry): ${outputBranch}`,
		"",
		"Conflicting files:",
		...fileLines,
	];
	const stderr = gitStderr.trim();
	if (stderr) {
		lines.push("", "Git reported:", stderr);
	}
	lines.push(
		"",
		"You cannot resolve this conflict yourself. It is a real content conflict: the same lines were changed on both the base branch and the plan branch while the plan ran, so Git cannot merge them automatically. Reconciling them requires a human decision about which changes to keep.",
		"",
		"Do this now:",
		"1. Give the user a short, plain-language summary of what failed and which files conflict.",
		"2. State clearly that you cannot resolve this automatically and that you need the user to reconcile the conflicting files (in the base branch and/or the plan).",
		"3. Tell the user that once the conflict is resolved, they must re-run /planner-finish to retry the export.",
		"",
		"Then stop and wait for the user. Do not retry the export, change planner state, or run Git merges yourself.",
	);
	return lines.join("\n");
}

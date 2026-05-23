import {
	ensureProjectWorktreesIgnored,
	type GitignoreWorktreeRuleResult,
} from "../project-local/gitignore";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { isProjectLocalWorktreePath } from "./paths";
import type { GitWorktreeRunner } from "./runner";

export interface CreatePlanWorktreeInput {
	fs: PlannerFs;
	runner: GitWorktreeRunner;
	projectPaths: ProjectStoragePaths;
	worktreePath: string;
	branch: string;
	fromRef?: string | null;
}

export interface CreatePlanWorktreeResult {
	path: string;
	branch: string;
	fromRef: string | null;
	gitignore: GitignoreWorktreeRuleResult | null;
}

export interface RemovePlanWorktreeInput {
	runner: GitWorktreeRunner;
	projectRoot: string;
	worktreePath: string;
	force?: boolean;
}

export interface RemovePlanWorktreeResult {
	path: string;
	force: boolean;
}

export async function createPlanWorktree(
	input: CreatePlanWorktreeInput,
): Promise<CreatePlanWorktreeResult> {
	const gitignore = isProjectLocalWorktreePath(
		input.projectPaths,
		input.worktreePath,
	)
		? await ensureProjectWorktreesIgnored(
				input.fs,
				input.projectPaths.projectRoot,
			)
		: null;

	await input.runner.add({
		repoRoot: input.projectPaths.projectRoot,
		path: input.worktreePath,
		branch: input.branch,
		fromRef: input.fromRef ?? null,
	});

	return {
		path: input.worktreePath,
		branch: input.branch,
		fromRef: input.fromRef ?? null,
		gitignore,
	};
}

export async function removePlanWorktree(
	input: RemovePlanWorktreeInput,
): Promise<RemovePlanWorktreeResult> {
	await input.runner.remove({
		repoRoot: input.projectRoot,
		path: input.worktreePath,
		force: input.force ?? false,
	});

	return {
		path: input.worktreePath,
		force: input.force ?? false,
	};
}

import type { GitRunner } from "../git/runner";
import {
	ensureProjectWorktreesIgnored,
	type GitignoreWorktreeRuleResult,
} from "../project-local/gitignore";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { isProjectLocalWorktreePath } from "./paths";

export interface CreatePlanWorktreeInput {
	fs: PlannerFs;
	git: GitRunner;
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
	git: GitRunner;
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

	await input.git.worktreeAdd({
		repoRoot: input.projectPaths.projectRoot,
		path: input.worktreePath,
		branch: input.branch,
		fromRef: input.fromRef ?? null,
	});
	await input.fs.mkdirp(input.worktreePath);

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
	await input.git.worktreeRemove({
		repoRoot: input.projectRoot,
		path: input.worktreePath,
		force: input.force ?? false,
	});

	return {
		path: input.worktreePath,
		force: input.force ?? false,
	};
}

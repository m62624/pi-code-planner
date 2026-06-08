import { dirname } from "node:path";
import type { GitRunner } from "../git/runner";
import {
	ensureProjectWorktreesIgnored,
	ensureProjectWorktreesLocallyExcluded,
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
	localExclude: GitignoreWorktreeRuleResult | null;
	bootstrapCommit: string | null;
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
	const projectLocal = isProjectLocalWorktreePath(
		input.projectPaths,
		input.worktreePath,
	);
	await ensureProjectRootHasCommits(
		input.fs,
		input.git,
		input.projectPaths.projectRoot,
	);
	await input.git.headCommit({ repoRoot: input.projectPaths.projectRoot });
	const localExclude = projectLocal
		? await ensureProjectWorktreesLocallyExcluded(
				input.fs,
				input.projectPaths.projectRoot,
				await resolveLocalExcludePath(
					input.git,
					input.projectPaths.projectRoot,
				),
			)
		: null;

	await input.fs.mkdirp(dirname(input.worktreePath));
	await input.git.worktreeAdd({
		repoRoot: input.projectPaths.projectRoot,
		path: input.worktreePath,
		branch: input.branch,
		fromRef: input.fromRef ?? null,
	});
	await input.fs.mkdirp(input.worktreePath);
	const initialStatus = await input.git.statusPorcelain({
		repoRoot: input.worktreePath,
	});
	if (initialStatus.trim().length > 0) {
		throw new Error(
			`New planner worktree is unexpectedly dirty before bootstrap: ${initialStatus}`,
		);
	}

	const gitignore = projectLocal
		? await ensureProjectWorktreesIgnored(input.fs, input.worktreePath)
		: null;
	const bootstrapCommit =
		gitignore && gitignore.action !== "unchanged"
			? await commitGitignoreBootstrap(input.git, input.worktreePath)
			: null;

	return {
		path: input.worktreePath,
		branch: input.branch,
		fromRef: input.fromRef ?? null,
		gitignore,
		localExclude,
		bootstrapCommit,
	};
}

async function ensureProjectRootHasCommits(
	fs: PlannerFs,
	git: GitRunner,
	projectRoot: string,
): Promise<void> {
	if (await git.hasCommits({ repoRoot: projectRoot })) {
		return;
	}

	// Repo has no commits yet (unborn HEAD). Create a minimal initial commit
	// so that `git worktree add` has a valid HEAD to branch from.
	const gitkeepPath = `${projectRoot}/.gitkeep`;
	await fs.writeTextAtomic(gitkeepPath, "");
	await git.stageAll({ repoRoot: projectRoot });
	await git.commit({ repoRoot: projectRoot, message: INITIAL_COMMIT_MESSAGE });
}

async function resolveLocalExcludePath(
	git: GitRunner,
	projectRoot: string,
): Promise<string | undefined> {
	return git.resolveGitPath
		? await git.resolveGitPath({
				repoRoot: projectRoot,
				path: "info/exclude",
			})
		: undefined;
}

export const WORKTREE_GITIGNORE_COMMIT_MESSAGE =
	"chore: ignore pi-code-planner worktrees";

export const INITIAL_COMMIT_MESSAGE =
	"initial commit (pi-planner: ensure repo has HEAD)";

async function commitGitignoreBootstrap(
	git: GitRunner,
	worktreePath: string,
): Promise<string> {
	await git.stageAll({ repoRoot: worktreePath });
	await git.commit({
		repoRoot: worktreePath,
		message: WORKTREE_GITIGNORE_COMMIT_MESSAGE,
	});
	const status = await git.statusPorcelain({ repoRoot: worktreePath });
	if (status.trim().length > 0) {
		throw new Error(
			`Planner worktree remains dirty after .gitignore bootstrap commit: ${status}`,
		);
	}
	return WORKTREE_GITIGNORE_COMMIT_MESSAGE;
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

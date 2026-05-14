import type { GitRunner } from "./runner";
import type { GitStatusSummary } from "./status-parser";
import { emptyGitStatusSummary, parsePorcelainStatus } from "./status-parser";

export interface RepoState {
	cwd: string;
	repoRoot: string | null;
	isRepo: boolean;
	currentBranch: string | null;
	currentCommit: string | null;
	isDetachedHead: boolean;
	status: GitStatusSummary;
}

export interface BranchState {
	currentBranch: string | null;
	isDetachedHead: boolean;
}

async function execTrimmed(
	runner: GitRunner,
	cwd: string,
	args: string[],
): Promise<string | null> {
	try {
		const result = await runner.exec(cwd, args);
		const trimmed = result.stdout.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch {
		return null;
	}
}

export async function getRepoRoot(
	runner: GitRunner,
	cwd: string,
): Promise<string | null> {
	return execTrimmed(runner, cwd, ["rev-parse", "--show-toplevel"]);
}

export async function getCurrentBranch(
	runner: GitRunner,
	cwd: string,
): Promise<string | null> {
	return execTrimmed(runner, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

export async function getBranchState(
	runner: GitRunner,
	cwd: string,
): Promise<BranchState> {
	const branch = await getCurrentBranch(runner, cwd);
	if (branch === "HEAD") {
		return { currentBranch: null, isDetachedHead: true };
	}
	return { currentBranch: branch, isDetachedHead: false };
}

export async function getCurrentCommit(
	runner: GitRunner,
	cwd: string,
): Promise<string | null> {
	return execTrimmed(runner, cwd, ["rev-parse", "HEAD"]);
}

export async function getRepoStatus(
	runner: GitRunner,
	cwd: string,
): Promise<GitStatusSummary> {
	try {
		const result = await runner.exec(cwd, ["status", "--porcelain"]);
		return parsePorcelainStatus(result.stdout);
	} catch {
		return emptyGitStatusSummary();
	}
}

export async function getRepoState(
	runner: GitRunner,
	cwd: string,
): Promise<RepoState> {
	const repoRoot = await getRepoRoot(runner, cwd);
	if (!repoRoot) {
		return {
			cwd,
			repoRoot: null,
			isRepo: false,
			currentBranch: null,
			currentCommit: null,
			isDetachedHead: false,
			status: emptyGitStatusSummary(),
		};
	}

	const [branchState, currentCommit, status] = await Promise.all([
		getBranchState(runner, cwd),
		getCurrentCommit(runner, cwd),
		getRepoStatus(runner, cwd),
	]);

	return {
		cwd,
		repoRoot,
		isRepo: true,
		currentBranch: branchState.currentBranch,
		currentCommit,
		isDetachedHead: branchState.isDetachedHead,
		status,
	};
}

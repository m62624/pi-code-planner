import { execFile } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type {
	GitBranchInput,
	GitCommitInput,
	GitCreateBranchInput,
	GitDeleteBranchInput,
	GitMergeInput,
	GitPathInput,
	GitRepoInput,
	GitRunner,
	GitSwitchBranchInput,
	GitWorktreeAddInput,
	GitWorktreeRemoveInput,
} from "./runner";

const execFileAsync = promisify(execFile);

export class GitCommandError extends Error {
	constructor(
		message: string,
		public readonly command: readonly string[],
		public readonly stderr: string,
	) {
		super(message);
		this.name = "GitCommandError";
	}
}

export class NodeGitRunner implements GitRunner {
	async init(input: GitRepoInput): Promise<void> {
		await runGitCommand(buildGitInitArgs(input));
	}

	async currentBranch(input: GitRepoInput): Promise<string> {
		return await runGitCommandOutput(buildGitCurrentBranchArgs(input));
	}

	async headCommit(input: GitRepoInput): Promise<string> {
		return await runGitCommandOutput(buildGitHeadCommitArgs(input));
	}

	async hasCommits(input: GitRepoInput): Promise<boolean> {
		try {
			await runGitCommand(buildGitHasCommitsArgs(input));
			return true;
		} catch {
			return false;
		}
	}

	async statusPorcelain(input: GitRepoInput): Promise<string> {
		return await runGitCommandOutput(buildGitStatusPorcelainArgs(input));
	}

	async diffStat(input: GitRepoInput): Promise<string> {
		return await runGitCommandOutput(buildGitDiffStatArgs(input));
	}

	async diffNameOnly(input: GitRepoInput): Promise<string> {
		return await runGitCommandOutput(buildGitDiffNameOnlyArgs(input));
	}

	async headFiles(input: GitRepoInput): Promise<string> {
		return await runGitCommandOutput(buildGitHeadFilesArgs(input));
	}

	async diffRange(
		input: GitRepoInput & { fromRef: string; toRef: string },
	): Promise<string> {
		return await runGitCommandOutput(buildGitDiffRangeArgs(input));
	}

	async logOneline(
		input: GitRepoInput & { fromRef: string; toRef: string },
	): Promise<string> {
		return await runGitCommandOutput(buildGitLogOnelineArgs(input));
	}

	async diffPatch(input: GitRepoInput): Promise<string> {
		return await runGitCommandOutput(buildGitDiffPatchArgs(input));
	}

	async resolveGitPath(input: GitPathInput): Promise<string> {
		const path = await runGitCommandOutput(buildGitPathArgs(input));
		return isAbsolute(path) ? path : resolve(input.repoRoot, path);
	}

	async listProjectFiles(input: GitRepoInput): Promise<string[]> {
		const output = await runGitCommandOutput(
			buildGitListProjectFilesArgs(input),
		);
		return output.split(/\r?\n/).filter(Boolean);
	}

	async branchExists(input: GitBranchInput): Promise<boolean> {
		try {
			await runGitCommand(buildGitBranchExistsArgs(input));
			return true;
		} catch {
			return false;
		}
	}

	async createBranch(input: GitCreateBranchInput): Promise<void> {
		await runGitCommand(buildGitCreateBranchArgs(input));
	}

	async deleteBranch(input: GitDeleteBranchInput): Promise<void> {
		await runGitCommand(buildGitDeleteBranchArgs(input));
	}

	async switchBranch(input: GitSwitchBranchInput): Promise<void> {
		await runGitCommand(buildGitSwitchBranchArgs(input));
	}

	async stageAll(input: GitRepoInput): Promise<void> {
		await runGitCommand(buildGitStageAllArgs(input));
	}

	async commit(input: GitCommitInput): Promise<void> {
		await runGitCommand(buildGitCommitArgs(input));
	}

	async merge(input: GitMergeInput): Promise<void> {
		await runGitCommand(buildGitMergeArgs(input));
	}

	async worktreeAdd(input: GitWorktreeAddInput): Promise<void> {
		await runGitCommand(buildGitWorktreeAddArgs(input));
	}

	async worktreeRemove(input: GitWorktreeRemoveInput): Promise<void> {
		await runGitCommand(buildGitWorktreeRemoveArgs(input));
	}
}

export function buildGitInitArgs(input: GitRepoInput): string[] {
	return ["-C", input.repoRoot, "init"];
}

export function buildGitCurrentBranchArgs(input: GitRepoInput): string[] {
	return ["-C", input.repoRoot, "branch", "--show-current"];
}

export function buildGitHeadCommitArgs(input: GitRepoInput): string[] {
	return ["-C", input.repoRoot, "rev-parse", "HEAD"];
}

export function buildGitHasCommitsArgs(input: GitRepoInput): string[] {
	return ["-C", input.repoRoot, "rev-parse", "--verify", "HEAD"];
}

export function buildGitStatusPorcelainArgs(input: GitRepoInput): string[] {
	return ["-C", input.repoRoot, "status", "--porcelain=v1"];
}

export function buildGitDiffStatArgs(input: GitRepoInput): string[] {
	return ["-C", input.repoRoot, "diff", "--stat"];
}

export function buildGitDiffNameOnlyArgs(input: GitRepoInput): string[] {
	return ["-C", input.repoRoot, "diff", "--name-only"];
}

export function buildGitHeadFilesArgs(input: GitRepoInput): string[] {
	return ["-C", input.repoRoot, "show", "--name-only", "--format=", "HEAD"];
}

export function buildGitDiffRangeArgs(
	input: GitRepoInput & { fromRef: string; toRef: string },
): string[] {
	return [
		"-C",
		input.repoRoot,
		"diff",
		"--stat",
		`${input.fromRef}..${input.toRef}`,
	];
}

export function buildGitLogOnelineArgs(
	input: GitRepoInput & { fromRef: string; toRef: string },
): string[] {
	return [
		"-C",
		input.repoRoot,
		"log",
		"--oneline",
		`${input.fromRef}..${input.toRef}`,
	];
}

export function buildGitDiffPatchArgs(input: GitRepoInput): string[] {
	return ["-C", input.repoRoot, "diff", "--patch", "--binary"];
}

export function buildGitPathArgs(input: GitPathInput): string[] {
	return ["-C", input.repoRoot, "rev-parse", "--git-path", input.path];
}

export function buildGitListProjectFilesArgs(input: GitRepoInput): string[] {
	return [
		"-C",
		input.repoRoot,
		"ls-files",
		"--cached",
		"--others",
		"--exclude-standard",
	];
}

export function buildGitBranchExistsArgs(input: GitBranchInput): string[] {
	return [
		"-C",
		input.repoRoot,
		"rev-parse",
		"--verify",
		"--quiet",
		input.branch,
	];
}

export function buildGitCreateBranchArgs(
	input: GitCreateBranchInput,
): string[] {
	return ["-C", input.repoRoot, "branch", input.branch, input.fromRef];
}

export function buildGitDeleteBranchArgs(
	input: GitDeleteBranchInput,
): string[] {
	return [
		"-C",
		input.repoRoot,
		"branch",
		input.force ? "-D" : "-d",
		input.branch,
	];
}

export function buildGitSwitchBranchArgs(
	input: GitSwitchBranchInput,
): string[] {
	return ["-C", input.repoRoot, "switch", input.branch];
}

export function buildGitStageAllArgs(input: GitRepoInput): string[] {
	return ["-C", input.repoRoot, "add", "-A"];
}

export function buildGitCommitArgs(input: GitCommitInput): string[] {
	return ["-C", input.repoRoot, "commit", "-m", input.message];
}

export function buildGitMergeArgs(input: GitMergeInput): string[] {
	return [
		"-C",
		input.repoRoot,
		"merge",
		...(input.noFastForward ? ["--no-ff"] : []),
		...(input.noCommit ? ["--no-commit"] : []),
		...(input.squash ? ["--squash"] : []),
		...(input.message ? ["-m", input.message] : []),
		input.sourceBranch,
	];
}

export function buildGitWorktreeAddArgs(input: GitWorktreeAddInput): string[] {
	if (input.fromRef) {
		return [
			"-C",
			input.repoRoot,
			"worktree",
			"add",
			"-b",
			input.branch,
			input.path,
			input.fromRef,
		];
	}
	return ["-C", input.repoRoot, "worktree", "add", input.path, input.branch];
}

export function buildGitWorktreeRemoveArgs(
	input: GitWorktreeRemoveInput,
): string[] {
	return [
		"-C",
		input.repoRoot,
		"worktree",
		"remove",
		...(input.force ? ["--force"] : []),
		input.path,
	];
}

async function runGitCommand(args: string[]): Promise<void> {
	try {
		await execFileAsync("git", args);
	} catch (error) {
		const stderr = getExecStderr(error);
		throw new GitCommandError(
			`git ${args.join(" ")} failed`,
			["git", ...args],
			stderr,
		);
	}
}

async function runGitCommandOutput(args: string[]): Promise<string> {
	try {
		const result = await execFileAsync("git", args);
		return result.stdout.trimEnd();
	} catch (error) {
		const stderr = getExecStderr(error);
		throw new GitCommandError(
			`git ${args.join(" ")} failed`,
			["git", ...args],
			stderr,
		);
	}
}

function getExecStderr(error: unknown): string {
	if (
		error &&
		typeof error === "object" &&
		"stderr" in error &&
		typeof error.stderr === "string"
	) {
		return error.stderr;
	}
	return "";
}

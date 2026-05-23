import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	GitRunner,
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
	async worktreeAdd(input: GitWorktreeAddInput): Promise<void> {
		await runGitCommand(buildGitWorktreeAddArgs(input));
	}

	async worktreeRemove(input: GitWorktreeRemoveInput): Promise<void> {
		await runGitCommand(buildGitWorktreeRemoveArgs(input));
	}
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

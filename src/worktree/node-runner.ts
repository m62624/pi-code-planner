import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
	GitWorktreeAddInput,
	GitWorktreeRemoveInput,
	GitWorktreeRunner,
} from "./runner";

const execFileAsync = promisify(execFile);

export class GitWorktreeCommandError extends Error {
	constructor(
		message: string,
		public readonly command: readonly string[],
		public readonly stderr: string,
	) {
		super(message);
		this.name = "GitWorktreeCommandError";
	}
}

export class NodeGitWorktreeRunner implements GitWorktreeRunner {
	async add(input: GitWorktreeAddInput): Promise<void> {
		await runGitWorktreeCommand(buildGitWorktreeAddArgs(input));
	}

	async remove(input: GitWorktreeRemoveInput): Promise<void> {
		await runGitWorktreeCommand(buildGitWorktreeRemoveArgs(input));
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

async function runGitWorktreeCommand(args: string[]): Promise<void> {
	try {
		await execFileAsync("git", args);
	} catch (error) {
		const stderr = getExecStderr(error);
		throw new GitWorktreeCommandError(
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

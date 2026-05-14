import type { GitCommandResult, GitRunner } from "./runner";

export interface GitWriter {
	initRepo(): Promise<GitCommandResult>;
	createBranch(
		branchName: string,
		startPoint?: string,
	): Promise<GitCommandResult>;
	createAndSwitchBranch(
		branchName: string,
		startPoint?: string,
	): Promise<GitCommandResult>;
	switchBranch(branchName: string): Promise<GitCommandResult>;
	deleteBranch(
		branchName: string,
		options?: DeleteBranchOptions,
	): Promise<GitCommandResult>;
	stageFiles(files: string[]): Promise<GitCommandResult>;
	stageAll(): Promise<GitCommandResult>;
	unstageFiles(files: string[]): Promise<GitCommandResult>;
	commit(message: string): Promise<GitCommandResult>;
	mergeBranch(
		branchName: string,
		options?: MergeBranchOptions,
	): Promise<GitCommandResult>;
	softReset(ref: string): Promise<GitCommandResult>;
	hardReset(ref: string): Promise<GitCommandResult>;
}

export interface DeleteBranchOptions {
	force?: boolean;
}

export interface MergeBranchOptions {
	noFastForward?: boolean;
	message?: string;
}

function requireNonEmpty(value: string, field: string): string {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new Error(`Git write field is required: ${field}`);
	}
	return trimmed;
}

function requireFiles(files: string[]): string[] {
	if (files.length === 0) {
		throw new Error("Git write field is required: files");
	}
	return files.map((file) => requireNonEmpty(file, "files"));
}

export class RunnerGitWriter implements GitWriter {
	constructor(
		private runner: GitRunner,
		private cwd: string,
	) {}

	initRepo(): Promise<GitCommandResult> {
		return this.exec(["init"]);
	}

	createBranch(
		branchName: string,
		startPoint?: string,
	): Promise<GitCommandResult> {
		const args = ["branch", requireNonEmpty(branchName, "branchName")];
		if (startPoint) args.push(requireNonEmpty(startPoint, "startPoint"));
		return this.exec(args);
	}

	createAndSwitchBranch(
		branchName: string,
		startPoint?: string,
	): Promise<GitCommandResult> {
		const args = ["switch", "-c", requireNonEmpty(branchName, "branchName")];
		if (startPoint) args.push(requireNonEmpty(startPoint, "startPoint"));
		return this.exec(args);
	}

	switchBranch(branchName: string): Promise<GitCommandResult> {
		return this.exec(["switch", requireNonEmpty(branchName, "branchName")]);
	}

	deleteBranch(
		branchName: string,
		options: DeleteBranchOptions = {},
	): Promise<GitCommandResult> {
		return this.exec([
			"branch",
			options.force ? "-D" : "-d",
			requireNonEmpty(branchName, "branchName"),
		]);
	}

	stageFiles(files: string[]): Promise<GitCommandResult> {
		return this.exec(["add", "--", ...requireFiles(files)]);
	}

	stageAll(): Promise<GitCommandResult> {
		return this.exec(["add", "--all"]);
	}

	unstageFiles(files: string[]): Promise<GitCommandResult> {
		return this.exec(["restore", "--staged", "--", ...requireFiles(files)]);
	}

	commit(message: string): Promise<GitCommandResult> {
		return this.exec(["commit", "-m", requireNonEmpty(message, "message")]);
	}

	mergeBranch(
		branchName: string,
		options: MergeBranchOptions = {},
	): Promise<GitCommandResult> {
		const args = ["merge"];
		if (options.noFastForward) args.push("--no-ff");
		if (options.message) {
			args.push("-m", requireNonEmpty(options.message, "message"));
		}
		args.push(requireNonEmpty(branchName, "branchName"));
		return this.exec(args);
	}

	softReset(ref: string): Promise<GitCommandResult> {
		return this.exec(["reset", "--soft", requireNonEmpty(ref, "ref")]);
	}

	hardReset(ref: string): Promise<GitCommandResult> {
		return this.exec(["reset", "--hard", requireNonEmpty(ref, "ref")]);
	}

	private exec(args: string[]): Promise<GitCommandResult> {
		return this.runner.exec(this.cwd, args);
	}
}

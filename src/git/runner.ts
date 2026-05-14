import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitCommandResult {
	stdout: string;
	stderr: string;
}

export interface GitRunner {
	exec(cwd: string, args: string[]): Promise<GitCommandResult>;
}

export class NodeGitRunner implements GitRunner {
	async exec(cwd: string, args: string[]): Promise<GitCommandResult> {
		const result = await execFileAsync("git", args, {
			cwd,
			maxBuffer: 1024 * 1024 * 10,
		});
		return {
			stdout: String(result.stdout),
			stderr: String(result.stderr),
		};
	}
}

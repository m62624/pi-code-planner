export interface GitWorktreeAddInput {
	repoRoot: string;
	path: string;
	branch: string;
	fromRef?: string | null;
}

export interface GitWorktreeRemoveInput {
	repoRoot: string;
	path: string;
	force?: boolean;
}

export interface GitRunner {
	worktreeAdd(input: GitWorktreeAddInput): Promise<void>;
	worktreeRemove(input: GitWorktreeRemoveInput): Promise<void>;
}

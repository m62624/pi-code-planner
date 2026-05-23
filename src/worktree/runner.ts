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

export interface GitWorktreeRunner {
	add(input: GitWorktreeAddInput): Promise<void>;
	remove(input: GitWorktreeRemoveInput): Promise<void>;
}

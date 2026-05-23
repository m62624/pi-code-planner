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

export interface GitRepoInput {
	repoRoot: string;
}

export interface GitBranchInput {
	repoRoot: string;
	branch: string;
}

export interface GitCreateBranchInput extends GitBranchInput {
	fromRef: string;
}

export interface GitDeleteBranchInput extends GitBranchInput {
	force?: boolean;
}

export interface GitSwitchBranchInput extends GitBranchInput {}

export interface GitMergeInput {
	repoRoot: string;
	sourceBranch: string;
	message?: string | null;
	noFastForward?: boolean;
	noCommit?: boolean;
}

export interface GitCommitInput {
	repoRoot: string;
	message: string;
}

export interface GitRunner {
	init(input: GitRepoInput): Promise<void>;
	currentBranch(input: GitRepoInput): Promise<string>;
	headCommit(input: GitRepoInput): Promise<string>;
	statusPorcelain(input: GitRepoInput): Promise<string>;
	diffStat(input: GitRepoInput): Promise<string>;
	diffNameOnly(input: GitRepoInput): Promise<string>;
	listProjectFiles(input: GitRepoInput): Promise<string[]>;
	branchExists(input: GitBranchInput): Promise<boolean>;
	createBranch(input: GitCreateBranchInput): Promise<void>;
	deleteBranch(input: GitDeleteBranchInput): Promise<void>;
	switchBranch(input: GitSwitchBranchInput): Promise<void>;
	stageAll(input: GitRepoInput): Promise<void>;
	commit(input: GitCommitInput): Promise<void>;
	merge(input: GitMergeInput): Promise<void>;
	worktreeAdd(input: GitWorktreeAddInput): Promise<void>;
	worktreeRemove(input: GitWorktreeRemoveInput): Promise<void>;
}

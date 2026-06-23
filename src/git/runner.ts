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

export interface GitPathInput extends GitRepoInput {
	path: string;
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
	squash?: boolean;
}

export interface GitCommitInput {
	repoRoot: string;
	message: string;
}

// The only git contract callers (worktree/manager.ts, src/runtime/) may
// depend on — never shell out to `git` directly outside an implementation of
// this interface, or tests lose the ability to substitute a mock runner.
export interface GitRunner {
	init(input: GitRepoInput): Promise<void>;
	currentBranch(input: GitRepoInput): Promise<string>;
	headCommit(input: GitRepoInput): Promise<string>;
	hasCommits(input: GitRepoInput): Promise<boolean>;
	statusPorcelain(input: GitRepoInput): Promise<string>;
	diffStat(input: GitRepoInput): Promise<string>;
	diffNameOnly(input: GitRepoInput): Promise<string>;
	diffPatch(input: GitRepoInput): Promise<string>;
	headFiles(input: GitRepoInput): Promise<string>;
	diffRange(
		input: GitRepoInput & { fromRef: string; toRef: string },
	): Promise<string>;
	logOneline(
		input: GitRepoInput & { fromRef: string; toRef: string },
	): Promise<string>;
	resolveGitPath?(input: GitPathInput): Promise<string>;
	listProjectFiles(input: GitRepoInput): Promise<string[]>;
	branchExists(input: GitBranchInput): Promise<boolean>;
	createBranch(input: GitCreateBranchInput): Promise<void>;
	deleteBranch(input: GitDeleteBranchInput): Promise<void>;
	switchBranch(input: GitSwitchBranchInput): Promise<void>;
	stageAll(input: GitRepoInput): Promise<void>;
	commit(input: GitCommitInput): Promise<void>;
	merge(input: GitMergeInput): Promise<void>;
	mergeAbort(input: GitRepoInput): Promise<void>;
	worktreeAdd(input: GitWorktreeAddInput): Promise<void>;
	worktreeRemove(input: GitWorktreeRemoveInput): Promise<void>;
	discardWorktreeChanges(input: GitRepoInput): Promise<void>;
}

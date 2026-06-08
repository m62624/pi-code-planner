import { describe, expect, it } from "vitest";
import type {
	GitBranchInput,
	GitCommitInput,
	GitCreateBranchInput,
	GitDeleteBranchInput,
	GitMergeInput,
	GitRepoInput,
	GitRunner,
	GitSwitchBranchInput,
	GitWorktreeAddInput,
	GitWorktreeRemoveInput,
} from "../git/runner";
import { PROJECT_WORKTREES_IGNORE_RULE } from "../project-local/gitignore";
import { createProjectStoragePaths } from "../storage/paths";
import { MockPlannerFs } from "../test/mock-fs";
import {
	createPlanWorktree,
	INITIAL_COMMIT_MESSAGE,
	removePlanWorktree,
	WORKTREE_GITIGNORE_COMMIT_MESSAGE,
} from "./manager";
import {
	createCustomWorktreeLocation,
	createProjectLocalWorktreeLocation,
	isProjectLocalWorktreePath,
} from "./paths";

class MockGitRunner implements GitRunner {
	readonly added: GitWorktreeAddInput[] = [];
	readonly removed: GitWorktreeRemoveInput[] = [];
	readonly staged: GitRepoInput[] = [];
	readonly commits: GitCommitInput[] = [];
	readonly statusChecks: GitRepoInput[] = [];

	constructor(private readonly statusResponses: string[] = []) {}

	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return "main";
	}
	async headCommit(_input: GitRepoInput): Promise<string> {
		return "abc123";
	}
	async hasCommits(_input: GitRepoInput): Promise<boolean> {
		return this.hasCommitsResult;
	}
	hasCommitsResult = true;
	statusPorcelain(input: GitRepoInput): Promise<string> {
		this.statusChecks.push(input);
		return this.statusResponses.shift() ?? "";
	}
	async diffStat(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffNameOnly(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async listProjectFiles(_input: GitRepoInput): Promise<string[]> {
		return [];
	}
	async branchExists(_input: GitBranchInput): Promise<boolean> {
		return true;
	}
	async createBranch(_input: GitCreateBranchInput): Promise<void> {}
	async deleteBranch(_input: GitDeleteBranchInput): Promise<void> {}
	async switchBranch(_input: GitSwitchBranchInput): Promise<void> {}
	async stageAll(input: GitRepoInput): Promise<void> {
		this.staged.push(input);
	}
	async commit(input: GitCommitInput): Promise<void> {
		this.commits.push(input);
	}
	async merge(_input: GitMergeInput): Promise<void> {}

	async worktreeAdd(input: GitWorktreeAddInput): Promise<void> {
		this.added.push(input);
	}

	async worktreeRemove(input: GitWorktreeRemoveInput): Promise<void> {
		this.removed.push(input);
	}
}

describe("worktree paths", () => {
	it("resolves default project-local worktree path", () => {
		const paths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const location = createProjectLocalWorktreeLocation(paths, "plan-a");

		expect(location).toEqual({
			kind: "project-local",
			root: "/repo/app/.pi/pi-code-planner/worktrees",
			path: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		});
		expect(isProjectLocalWorktreePath(paths, location.path)).toBe(true);
		expect(
			isProjectLocalWorktreePath(
				paths,
				"/repo/app/.pi/pi-code-planner/worktrees",
			),
		).toBe(false);
		expect(
			isProjectLocalWorktreePath(
				paths,
				"/repo/app/.pi/pi-code-planner/instructions/append",
			),
		).toBe(false);
	});

	it("resolves custom worktree path", () => {
		const paths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		expect(
			createCustomWorktreeLocation({
				root: "/tmp/worktrees",
				projectId: paths.projectId,
				planId: "plan-a",
			}),
		).toMatchObject({
			kind: "custom",
			path: `/tmp/worktrees/${paths.projectId}/plan-a`,
		});
	});
});

describe("worktree manager", () => {
	it("creates project-local worktree and commits its .gitignore bootstrap", async () => {
		const fs = new MockPlannerFs();
		const git = new MockGitRunner();
		const paths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const location = createProjectLocalWorktreeLocation(paths, "plan-a");

		const result = await createPlanWorktree({
			fs,
			git,
			projectPaths: paths,
			worktreePath: location.path,
			branch: "plan/plan-a",
			fromRef: "main",
		});

		expect(result.gitignore?.action).toBe("created");
		expect(result.localExclude?.action).toBe("created");
		expect(result.bootstrapCommit).toBe(WORKTREE_GITIGNORE_COMMIT_MESSAGE);
		expect(
			fs.snapshot()[
				"/repo/app/.pi/pi-code-planner/worktrees/plan-a/.gitignore"
			],
		).toBe(`${PROJECT_WORKTREES_IGNORE_RULE}\n`);
		expect(fs.snapshot()["/repo/app/.git/info/exclude"]).toBe(
			`${PROJECT_WORKTREES_IGNORE_RULE}\n`,
		);
		expect(git.added).toEqual([
			{
				repoRoot: "/repo/app",
				path: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				branch: "plan/plan-a",
				fromRef: "main",
			},
		]);
		expect(git.staged).toEqual([
			{
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			},
		]);
		expect(git.commits).toEqual([
			{
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				message: WORKTREE_GITIGNORE_COMMIT_MESSAGE,
			},
		]);
		expect(git.statusChecks).toEqual([
			{
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			},
			{
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			},
		]);
	});

	it("creates custom worktree without touching .gitignore", async () => {
		const fs = new MockPlannerFs();
		const git = new MockGitRunner();
		const paths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const location = createCustomWorktreeLocation({
			root: "/tmp/worktrees",
			projectId: paths.projectId,
			planId: "plan-a",
		});

		const result = await createPlanWorktree({
			fs,
			git,
			projectPaths: paths,
			worktreePath: location.path,
			branch: "plan/plan-a",
		});

		expect(result.gitignore).toBeNull();
		expect(result.localExclude).toBeNull();
		expect(result.bootstrapCommit).toBeNull();
		expect(await fs.exists("/repo/app/.gitignore")).toBe(false);
		expect(git.added).toEqual([
			{
				repoRoot: "/repo/app",
				path: location.path,
				branch: "plan/plan-a",
				fromRef: null,
			},
		]);
	});

	it("does not create a bootstrap commit when the plan branch already has the rule", async () => {
		const fs = new MockPlannerFs();
		const git = new MockGitRunner();
		const paths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const location = createProjectLocalWorktreeLocation(paths, "plan-a");
		await fs.writeTextAtomic(
			`${location.path}/.gitignore`,
			`${PROJECT_WORKTREES_IGNORE_RULE}\n`,
		);

		const result = await createPlanWorktree({
			fs,
			git,
			projectPaths: paths,
			worktreePath: location.path,
			branch: "plan/plan-a",
			fromRef: "main",
		});

		expect(result.gitignore?.action).toBe("unchanged");
		expect(result.bootstrapCommit).toBeNull();
		expect(git.staged).toEqual([]);
		expect(git.commits).toEqual([]);
	});

	it("commits the bootstrap when the rule is appended to an existing .gitignore", async () => {
		const fs = new MockPlannerFs();
		const git = new MockGitRunner();
		const paths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const location = createProjectLocalWorktreeLocation(paths, "plan-a");
		await fs.writeTextAtomic(`${location.path}/.gitignore`, "dist/\n");

		const result = await createPlanWorktree({
			fs,
			git,
			projectPaths: paths,
			worktreePath: location.path,
			branch: "plan/plan-a",
			fromRef: "main",
		});

		expect(result.gitignore?.action).toBe("appended");
		expect(result.bootstrapCommit).toBe(WORKTREE_GITIGNORE_COMMIT_MESSAGE);
		expect(fs.snapshot()[`${location.path}/.gitignore`]).toBe(
			`dist/\n${PROJECT_WORKTREES_IGNORE_RULE}\n`,
		);
		expect(git.commits).toHaveLength(1);
	});

	it("refuses to bootstrap an unexpectedly dirty new worktree", async () => {
		const fs = new MockPlannerFs();
		const git = new MockGitRunner([" M generated.txt\n"]);
		const paths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const location = createProjectLocalWorktreeLocation(paths, "plan-a");

		await expect(
			createPlanWorktree({
				fs,
				git,
				projectPaths: paths,
				worktreePath: location.path,
				branch: "plan/plan-a",
				fromRef: "main",
			}),
		).rejects.toThrow("unexpectedly dirty before bootstrap");
		expect(git.staged).toEqual([]);
		expect(git.commits).toEqual([]);
	});

	it("removes worktree through runner without deleting plan files itself", async () => {
		const git = new MockGitRunner();

		const result = await removePlanWorktree({
			git,
			projectRoot: "/repo/app",
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			force: true,
		});

		expect(result).toEqual({
			path: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			force: true,
		});
		expect(git.removed).toEqual([
			{
				repoRoot: "/repo/app",
				path: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				force: true,
			},
		]);
	});

	it("creates an initial commit when the repo has no commits yet", async () => {
		const fs = new MockPlannerFs();
		const git = new MockGitRunner();
		git.hasCommitsResult = false;
		const paths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const location = createProjectLocalWorktreeLocation(paths, "plan-a");

		const result = await createPlanWorktree({
			fs,
			git,
			projectPaths: paths,
			worktreePath: location.path,
			branch: "plan/plan-a",
			fromRef: "main",
		});

		expect(result.gitignore?.action).toBe("created");
		expect(git.staged).toEqual([
			{ repoRoot: "/repo/app" },
			{
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			},
		]);
		expect(git.commits).toHaveLength(2);
		expect(git.commits[0]).toEqual({
			repoRoot: "/repo/app",
			message: INITIAL_COMMIT_MESSAGE,
		});
		expect(git.commits[1]).toEqual({
			repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			message: WORKTREE_GITIGNORE_COMMIT_MESSAGE,
		});
		expect(fs.snapshot()["/repo/app/.gitkeep"]).toBe("");
	});
});

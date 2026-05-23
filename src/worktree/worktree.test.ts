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
import { createPlanWorktree, removePlanWorktree } from "./manager";
import {
	createCustomWorktreeLocation,
	createProjectLocalWorktreeLocation,
	isProjectLocalWorktreePath,
} from "./paths";

class MockGitRunner implements GitRunner {
	readonly added: GitWorktreeAddInput[] = [];
	readonly removed: GitWorktreeRemoveInput[] = [];

	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return "main";
	}
	async headCommit(_input: GitRepoInput): Promise<string> {
		return "abc123";
	}
	async statusPorcelain(_input: GitRepoInput): Promise<string> {
		return "";
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
	async stageAll(_input: GitRepoInput): Promise<void> {}
	async commit(_input: GitCommitInput): Promise<void> {}
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
	it("creates project-local worktree and prepares .gitignore", async () => {
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
		expect(fs.snapshot()["/repo/app/.gitignore"]).toBe(
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
});

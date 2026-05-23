import { describe, expect, it } from "vitest";
import { PROJECT_WORKTREES_IGNORE_RULE } from "../project-local/gitignore";
import { createProjectStoragePaths } from "../storage/paths";
import { MockPlannerFs } from "../test/mock-fs";
import { createPlanWorktree, removePlanWorktree } from "./manager";
import {
	createAgentDirWorktreeLocation,
	createCustomWorktreeLocation,
	createProjectLocalWorktreeLocation,
	isProjectLocalWorktreePath,
} from "./paths";
import type {
	GitWorktreeAddInput,
	GitWorktreeRemoveInput,
	GitWorktreeRunner,
} from "./runner";

class MockGitWorktreeRunner implements GitWorktreeRunner {
	readonly added: GitWorktreeAddInput[] = [];
	readonly removed: GitWorktreeRemoveInput[] = [];

	async add(input: GitWorktreeAddInput): Promise<void> {
		this.added.push(input);
	}

	async remove(input: GitWorktreeRemoveInput): Promise<void> {
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

	it("resolves agent-dir and custom worktree paths", () => {
		const paths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		expect(createAgentDirWorktreeLocation(paths, "plan-a")).toMatchObject({
			kind: "agent-dir",
			path: `${paths.projectDir}/worktrees/plan-a`,
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
		const runner = new MockGitWorktreeRunner();
		const paths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const location = createProjectLocalWorktreeLocation(paths, "plan-a");

		const result = await createPlanWorktree({
			fs,
			runner,
			projectPaths: paths,
			worktreePath: location.path,
			branch: "plan/plan-a",
			fromRef: "main",
		});

		expect(result.gitignore?.action).toBe("created");
		expect(fs.snapshot()["/repo/app/.gitignore"]).toBe(
			`${PROJECT_WORKTREES_IGNORE_RULE}\n`,
		);
		expect(runner.added).toEqual([
			{
				repoRoot: "/repo/app",
				path: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				branch: "plan/plan-a",
				fromRef: "main",
			},
		]);
	});

	it("creates non-project-local worktree without touching .gitignore", async () => {
		const fs = new MockPlannerFs();
		const runner = new MockGitWorktreeRunner();
		const paths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const location = createAgentDirWorktreeLocation(paths, "plan-a");

		const result = await createPlanWorktree({
			fs,
			runner,
			projectPaths: paths,
			worktreePath: location.path,
			branch: "plan/plan-a",
		});

		expect(result.gitignore).toBeNull();
		expect(await fs.exists("/repo/app/.gitignore")).toBe(false);
		expect(runner.added).toEqual([
			{
				repoRoot: "/repo/app",
				path: location.path,
				branch: "plan/plan-a",
				fromRef: null,
			},
		]);
	});

	it("removes worktree through runner without deleting plan files itself", async () => {
		const runner = new MockGitWorktreeRunner();

		const result = await removePlanWorktree({
			runner,
			projectRoot: "/repo/app",
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			force: true,
		});

		expect(result).toEqual({
			path: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			force: true,
		});
		expect(runner.removed).toEqual([
			{
				repoRoot: "/repo/app",
				path: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				force: true,
			},
		]);
	});
});

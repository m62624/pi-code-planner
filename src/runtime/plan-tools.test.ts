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
import {
	createInstructionPaths,
	instructionFilePath,
} from "../instructions/paths";
import { INSTRUCTION_KEYS } from "../instructions/schema";
import { readMemoryCheckpoint } from "../memory/manager";
import { createMemoryStoragePaths } from "../memory/paths";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import { readPlanRecord } from "../storage/plan-store";
import { readProjectRecord, setActivePlan } from "../storage/project-store";
import { readPlanState } from "../storage/state-store";
import { createWorktreeProjectIndexPath } from "../storage/worktree-index";
import { MockPlannerFs } from "../test/mock-fs";
import { executePlannerPlanTool } from "./plan-tools";

class MockGitRunner implements GitRunner {
	failCurrentBranch = false;
	readonly calls: Array<{ name: string; input: unknown }> = [];
	private branch: string;

	constructor(branch = "main") {
		this.branch = branch;
	}

	async init(input: GitRepoInput): Promise<void> {
		this.calls.push({ name: "init", input });
	}
	async currentBranch(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "currentBranch", input });
		if (this.failCurrentBranch && input.repoRoot === "/repo/app") {
			throw new Error("not a git repository");
		}
		return this.branch;
	}
	async headCommit(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "headCommit", input });
		return "abc123";
	}
	async statusPorcelain(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "statusPorcelain", input });
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
		this.calls.push({ name: "worktreeAdd", input });
		this.branch = input.branch;
	}
	async worktreeRemove(_input: GitWorktreeRemoveInput): Promise<void> {}
}

describe("planner plan tools", () => {
	it("creates project, plan, state, memory, instructions, and activates the plan", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const result = await executePlannerPlanTool({
			fs,
			git: new MockGitRunner("feature/base"),
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "API Audit",
				title: "Audit approval modes",
			},
		});

		expect(result.status).toBe("applied");
		expect(result.text).toContain("Plan: api-audit");

		const planPaths = createPlanStoragePaths(projectPaths, "api-audit");
		const memoryPaths = createMemoryStoragePaths(planPaths);
		await expect(readProjectRecord(fs, projectPaths)).resolves.toMatchObject({
			activePlanId: "api-audit",
			plans: [
				{
					planId: "api-audit",
					title: "Audit approval modes",
					status: "active",
				},
			],
		});
		await expect(readPlanRecord(fs, planPaths)).resolves.toMatchObject({
			planId: "api-audit",
			title: "Audit approval modes",
			status: "active",
			tasks: [],
		});
		await expect(readPlanState(fs, planPaths)).resolves.toMatchObject({
			stage: "discovery",
			step: "read_project",
			stepStatus: "pending",
			activeBranches: {
				base: "feature/base",
				plan: "plan/api-audit",
			},
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/api-audit",
			currentBranch: "plan/api-audit",
			lastCheckpointCommit: "abc123",
			requiresMemoryUpdate: false,
		});
		await expect(readMemoryCheckpoint(fs, memoryPaths)).resolves.toMatchObject({
			commit: null,
		});
		expect(fs.snapshot()[planPaths.planMd]).toBe("");
		expect(fs.snapshot()[planPaths.discoveryMd]).toBe("");
		expect(fs.snapshot()["/repo/app/.gitignore"]).toBe(
			".pi/pi-code-planner/worktrees/\n",
		);
		await expect(
			fs.exists("/repo/app/.pi/pi-code-planner/worktrees/api-audit"),
		).resolves.toBe(true);
		expect(
			fs.snapshot()[
				createWorktreeProjectIndexPath({
					agentDir: "/agent",
					worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/api-audit",
				})
			],
		).toBeDefined();

		const instructionPaths = createInstructionPaths(projectPaths);
		for (const key of INSTRUCTION_KEYS) {
			expect(
				fs.snapshot()[instructionFilePath(instructionPaths.defaultsDir, key)],
			).toBeDefined();
			expect(
				fs.snapshot()[
					instructionFilePath(instructionPaths.globalAppendDir, key)
				],
			).toBe("");
		}
	});

	it("uses explicit baseBranch and blocks accidental overwrite of an active plan", async () => {
		const fs = new MockPlannerFs();
		const git = new MockGitRunner("ignored");
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const created = await executePlannerPlanTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-a",
				title: "Plan A",
				baseBranch: "release/1",
			},
		});
		expect(created.status).toBe("applied");

		const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
		await expect(readPlanState(fs, planPaths)).resolves.toMatchObject({
			activeBranches: {
				base: "release/1",
				plan: "plan/plan-a",
			},
		});
		expect(git.calls).toContainEqual({
			name: "worktreeAdd",
			input: {
				repoRoot: "/repo/app",
				path: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				branch: "plan/plan-a",
				fromRef: "release/1",
			},
		});

		const blocked = await executePlannerPlanTool({
			fs,
			git: new MockGitRunner(),
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-b",
				title: "Plan B",
			},
		});

		expect(blocked.status).toBe("blocked");
		expect(blocked.text).toContain("already has an active planner plan");
	});

	it("falls back to main when git branch inspection is unavailable", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		const git = new MockGitRunner();
		git.failCurrentBranch = true;

		const result = await executePlannerPlanTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-a",
				title: "Plan A",
			},
		});

		expect(result.status).toBe("applied");
		await expect(
			readPlanState(fs, createPlanStoragePaths(projectPaths, "plan-a")),
		).resolves.toMatchObject({
			activeBranches: { base: "main" },
		});
	});

	it("uses project settings custom worktree settings without adding a project-local gitignore rule", async () => {
		const fs = new MockPlannerFs();
		const git = new MockGitRunner("main");
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/repo/app/.pi/pi-code-planner/settings.json",
			`${JSON.stringify({
				worktree: {
					mode: "custom",
					root: "/tmp/planner-worktrees",
				},
			})}\n`,
		);

		const result = await executePlannerPlanTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-a",
				title: "Plan A",
			},
		});

		expect(result.status).toBe("applied");
		const expectedPath = `/tmp/planner-worktrees/${projectPaths.projectId}/plan-a`;
		await expect(
			readPlanState(fs, createPlanStoragePaths(projectPaths, "plan-a")),
		).resolves.toMatchObject({
			worktreePath: expectedPath,
		});
		expect(git.calls).toContainEqual({
			name: "worktreeAdd",
			input: {
				repoRoot: "/repo/app",
				path: expectedPath,
				branch: "plan/plan-a",
				fromRef: "main",
			},
		});
		await expect(fs.exists("/repo/app/.gitignore")).resolves.toBe(false);
	});

	it("uses global settings custom worktree settings when project settings are absent", async () => {
		const fs = new MockPlannerFs();
		const git = new MockGitRunner("main");
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});
		await fs.writeTextAtomic(
			"/agent/extensions/pi-code-planner/settings.json",
			`${JSON.stringify({
				worktree: {
					mode: "custom",
					root: "/global/worktrees",
				},
			})}\n`,
		);

		const result = await executePlannerPlanTool({
			fs,
			git,
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-a",
				title: "Plan A",
			},
		});

		expect(result.status).toBe("applied");
		const expectedPath = `/global/worktrees/${projectPaths.projectId}/plan-a`;
		await expect(
			readPlanState(fs, createPlanStoragePaths(projectPaths, "plan-a")),
		).resolves.toMatchObject({
			worktreePath: expectedPath,
		});
		expect(git.calls).toContainEqual({
			name: "worktreeAdd",
			input: {
				repoRoot: "/repo/app",
				path: expectedPath,
				branch: "plan/plan-a",
				fromRef: "main",
			},
		});
	});

	it("blocks creating an existing inactive plan instead of overwriting files", async () => {
		const fs = new MockPlannerFs();
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const first = await executePlannerPlanTool({
			fs,
			git: new MockGitRunner(),
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-a",
				title: "Plan A",
			},
		});
		expect(first.status).toBe("applied");
		await setActivePlan(fs, projectPaths, null);

		const second = await executePlannerPlanTool({
			fs,
			git: new MockGitRunner(),
			projectPaths,
			toolName: "planner_create_plan",
			params: {
				planId: "plan-a",
				title: "Plan A again",
			},
		});

		expect(second.status).toBe("blocked");
		expect(second.text).toContain("Planner plan already exists: plan-a");
	});
});

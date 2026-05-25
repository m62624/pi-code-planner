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
import { MockPlannerFs } from "../test/mock-fs";
import { executePlannerPlanTool } from "./plan-tools";

class MockGitRunner implements GitRunner {
	failCurrentBranch = false;

	constructor(private readonly branch = "main") {}

	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		if (this.failCurrentBranch) {
			throw new Error("not a git repository");
		}
		return this.branch;
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
	async worktreeAdd(_input: GitWorktreeAddInput): Promise<void> {}
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
			stage: "init",
			step: "check_project",
			stepStatus: "pending",
			activeBranches: {
				base: "feature/base",
				plan: "plan/api-audit",
			},
			worktreePath: null,
			lastCheckpointCommit: null,
			requiresMemoryUpdate: false,
		});
		await expect(readMemoryCheckpoint(fs, memoryPaths)).resolves.toMatchObject({
			commit: null,
		});
		expect(fs.snapshot()[planPaths.planMd]).toBe("");
		expect(fs.snapshot()[planPaths.discoveryMd]).toBe("");

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
		const projectPaths = createProjectStoragePaths({
			agentDir: "/agent",
			projectRoot: "/repo/app",
		});

		const created = await executePlannerPlanTool({
			fs,
			git: new MockGitRunner("ignored"),
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

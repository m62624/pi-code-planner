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
	createPlanStoragePaths,
	createProjectStoragePaths,
	createTaskStoragePaths,
} from "../storage/paths";
import {
	initializePlanFiles,
	readPlanRecord,
	updatePlanRecord,
} from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import { createInitialPlanState, createPlanRecord } from "../storage/schema";
import { initializePlanState } from "../storage/state-store";
import { readTaskRecord, updateTaskStatus } from "../storage/task-store";
import { MockPlannerFs } from "../test/mock-fs";
import { executePlannerTaskTool } from "./task-tools";

class MockGitRunner implements GitRunner {
	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return "plan/plan-a";
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

describe("planner task tools", () => {
	it("writes generated task artifacts and updates the plan task summary", async () => {
		const setup = await createTaskSetup();
		const result = await executePlannerTaskTool({
			...setup,
			toolName: "planner_task_upsert",
			params: {
				taskId: "parse-config",
				title: "Parse configuration",
				objective: "Parse config files with typed validation.",
				scope: ["src/config.ts"],
				acceptanceCriteria: ["Invalid input returns a typed error."],
			},
		});

		expect(result.status).toBe("applied");
		await expect(
			readPlanRecord(setup.fs, setup.planPaths),
		).resolves.toMatchObject({
			tasks: [
				{
					taskId: "parse-config",
					title: "Parse configuration",
					status: "pending",
				},
			],
		});
		await expect(
			readTaskRecord(
				setup.fs,
				createTaskStoragePaths(setup.planPaths, "parse-config"),
			),
		).resolves.toMatchObject({
			objective: "Parse config files with typed validation.",
		});
	});

	it("persists dependsOn through the upsert tool", async () => {
		const setup = await createTaskSetup();
		const result = await executePlannerTaskTool({
			...setup,
			toolName: "planner_task_upsert",
			params: {
				taskId: "model-task",
				title: "Model",
				objective: "Builds on scaffolding.",
				scope: ["src/model.ts"],
				acceptanceCriteria: ["Depends on setup."],
				dependsOn: ["setup-project"],
			},
		});
		expect(result.status).toBe("applied");
		await expect(
			readTaskRecord(
				setup.fs,
				createTaskStoragePaths(setup.planPaths, "model-task"),
			),
		).resolves.toMatchObject({ dependsOn: ["setup-project"] });
	});

	it("blocks reopening a completed task id during follow-up planning", async () => {
		const setup = await createTaskSetup();
		const createResult = await executePlannerTaskTool({
			...setup,
			toolName: "planner_task_upsert",
			params: {
				taskId: "parse-config",
				title: "Parse configuration",
				objective: "Parse config files with typed validation.",
				scope: ["src/config.ts"],
				acceptanceCriteria: ["Invalid input returns a typed error."],
			},
		});
		expect(createResult.status).toBe("applied");
		const taskPaths = createTaskStoragePaths(setup.planPaths, "parse-config");
		await updatePlanRecord(setup.fs, setup.planPaths, (plan) => ({
			...plan,
			tasks: plan.tasks.map((task) => ({ ...task, status: "done" })),
		}));
		await updateTaskStatus(setup.fs, taskPaths, "done");

		const result = await executePlannerTaskTool({
			...setup,
			toolName: "planner_task_upsert",
			params: {
				taskId: "parse-config",
				title: "Parse configuration revision",
				objective: "Reopen old completed work.",
				scope: ["src/config.ts"],
				acceptanceCriteria: ["Old task is mutable."],
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("already done");
		await expect(readTaskRecord(setup.fs, taskPaths)).resolves.toMatchObject({
			title: "Parse configuration",
			status: "done",
		});
	});
});

async function createTaskSetup() {
	const fs = new MockPlannerFs();
	const git = new MockGitRunner();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const worktreePath = "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
	await ensureProjectRecord(fs, projectPaths);
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId: "plan-a", title: "Plan A" }),
	);
	await fs.mkdirp(worktreePath);
	await initializePlanState(fs, planPaths, {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		stage: "planning",
		step: "write_task_files",
		stepStatus: "running",
		currentBranch: "plan/plan-a",
	});
	await setActivePlan(fs, projectPaths, "plan-a");
	return { fs, git, projectPaths, planPaths };
}

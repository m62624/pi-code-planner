import { join } from "node:path";
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
	initializeMemoryFiles,
	upsertFileEntries,
	writeMemoryCheckpoint,
} from "../memory/manager";
import { createMemoryStoragePaths } from "../memory/paths";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
	type PlanStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import { initializePlanFiles } from "../storage/plan-store";
import { ensureProjectRecord, setActivePlan } from "../storage/project-store";
import {
	createInitialPlanState,
	createPlanRecord,
	type PlanStateRecord,
} from "../storage/schema";
import { initializePlanState, readPlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";

describe("planner lifecycle orchestrator", () => {
	it("builds one recommended next action and exposes allowed tools for a pending step", async () => {
		const setup = await createOrchestratorSetup({
			stage: "planning",
			step: "draft_plan",
			stepStatus: "pending",
		});

		const result = await runPlannerOrchestrator({
			fs: setup.fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
		});

		expect(result.lifecycle).toMatchObject({
			action: "start_step",
			requiredTool: "planner_start_step",
			requiredTransition: "start_step",
		});
		expect(result.behavior).toMatchObject({
			stage: "planning",
			step: "draft_plan",
			projectAccess: "planner_artifacts",
		});
		expect(result.nextAction).toMatchObject({
			kind: "tool",
			toolName: "planner_start_step",
			transition: "start_step",
		});
		expect(result.allowedWorkflowTools).toContain("planner_start_step");
		expect(result.allowedTools).toContain("planner_status");
		expect(result.statusText).toContain("## Lifecycle Decision");
		expect(result.statusText).toContain("- stage: planning");
	});

	it("blocks workflow tools that do not match the current state-machine gate", async () => {
		const setup = await createOrchestratorSetup({
			stage: "planning",
			step: "draft_plan",
			stepStatus: "pending",
		});
		const result = await runPlannerOrchestrator({
			fs: setup.fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
		});

		const decision = checkPlannerOrchestratorToolAllowed({
			orchestrator: result,
			toolName: "planner_finish_step",
		});

		expect(decision).toMatchObject({
			allow: false,
			toolName: "planner_finish_step",
		});
		expect(decision.reason).toContain(
			"Planner tool planner_finish_step is blocked",
		);
		expect(decision.reason).toContain("Allowed transitions: start_step");
	});

	it("blocks wrapper tools until the current step is running", async () => {
		const setup = await createOrchestratorSetup({
			stage: "execution",
			step: "prepare_task",
			stepStatus: "pending",
		});
		const result = await runPlannerOrchestrator({
			fs: setup.fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
		});

		const decision = checkPlannerOrchestratorToolAllowed({
			orchestrator: result,
			toolName: "planner_git_create_task_branch",
		});

		expect(result.allowedWrapperTools).not.toContain(
			"planner_git_create_task_branch",
		);
		expect(decision.allow).toBe(false);
		expect(decision.reason).toContain("is pending");
		expect(decision.reason).toContain("planner_start_step");
	});

	it("allows behavior-compatible wrapper tools while the current step is running", async () => {
		const setup = await createOrchestratorSetup({
			stage: "execution",
			step: "prepare_task",
			stepStatus: "running",
		});
		const result = await runPlannerOrchestrator({
			fs: setup.fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
		});

		const decision = checkPlannerOrchestratorToolAllowed({
			orchestrator: result,
			toolName: "planner_git_create_task_branch",
		});

		expect(result.allowedWrapperTools).toContain(
			"planner_git_create_task_branch",
		);
		expect(decision.allow).toBe(true);
	});

	it("routes external HEAD changes through memory checkpoint sync before normal lifecycle", async () => {
		const setup = await createOrchestratorSetup({
			stage: "execution",
			step: "merge_task_to_plan",
			stepStatus: "running",
			lastCheckpointCommit: "old123",
		});
		await writeMemoryCheckpoint(setup.fs, setup.memoryPaths, "old123");

		const result = await runPlannerOrchestrator({
			fs: setup.fs,
			git: new MockGitRunner({ head: "new456" }),
			projectPaths: setup.projectPaths,
		});

		expect(result.lifecycle).toMatchObject({
			action: "sync_memory_checkpoint",
			requiredTool: "planner_memory_sync_checkpoint",
			runtimeAction: "require_memory_update",
		});
		expect(result.nextAction).toMatchObject({
			kind: "tool",
			toolName: "planner_memory_sync_checkpoint",
		});
		expect(result.allowedWrapperTools).toContain("planner_memory_inspect");
		expect(await readPlanState(setup.fs, setup.planPaths)).toMatchObject({
			requiresMemoryUpdate: true,
			memoryUpdateReason: "external_commit",
		});
	});

	it("routes wrong branch state into recovery inspection only", async () => {
		const setup = await createOrchestratorSetup({
			stage: "execution",
			step: "run_experiment",
			stepStatus: "running",
			currentBranch: "experiment/plan-a/task-1/a",
		});

		const result = await runPlannerOrchestrator({
			fs: setup.fs,
			git: new MockGitRunner({ branch: "task/plan-a/task-1" }),
			projectPaths: setup.projectPaths,
		});

		expect(result.lifecycle).toMatchObject({
			action: "inspect_recovery",
			requiredTool: "planner_recovery_inspect",
			runtimeAction: "require_recovery",
		});
		expect(result.allowedWrapperTools).toContain("planner_recovery_inspect");
		expect(result.allowedWorkflowTools).toEqual([
			"planner_resume_after_recovery",
		]);
	});

	it("requires compact completion when a compact gate is pending", async () => {
		const setup = await createOrchestratorSetup({
			stage: "discovery",
			step: "compact_discovery",
			stepStatus: "blocked",
			requiresCompact: true,
		});

		const result = await runPlannerOrchestrator({
			fs: setup.fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
		});

		expect(result.lifecycle).toMatchObject({
			action: "compact_pending",
			requiredTool: "planner_complete_compact",
			requiredTransition: "complete_compact",
		});
		expect(result.allowedWorkflowTools).toEqual(["planner_complete_compact"]);
	});
});

class MockGitRunner implements GitRunner {
	constructor(
		private readonly input: {
			branch?: string;
			head?: string;
			status?: string;
			files?: string[];
		} = {},
	) {}

	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return this.input.branch ?? "plan/plan-a";
	}
	async headCommit(_input: GitRepoInput): Promise<string> {
		return this.input.head ?? "abc123";
	}
	async statusPorcelain(_input: GitRepoInput): Promise<string> {
		return this.input.status ?? "";
	}
	async diffStat(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffNameOnly(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async listProjectFiles(_input: GitRepoInput): Promise<string[]> {
		return this.input.files ?? ["src/a.ts"];
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

async function createOrchestratorSetup(
	statePatch: Partial<PlanStateRecord> = {},
): Promise<{
	fs: MockPlannerFs;
	projectPaths: ProjectStoragePaths;
	planPaths: PlanStoragePaths;
	memoryPaths: ReturnType<typeof createMemoryStoragePaths>;
}> {
	const fs = new MockPlannerFs();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const memoryPaths = createMemoryStoragePaths(planPaths);
	const worktreePath = join(
		projectPaths.projectRoot,
		".pi",
		"pi-code-planner",
		"worktrees",
		"plan-a",
	);
	await ensureProjectRecord(fs, projectPaths);
	await initializePlanFiles(
		fs,
		planPaths,
		createPlanRecord({ planId: "plan-a", title: "Plan A" }),
	);
	await initializePlanState(fs, planPaths, {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		currentBranch: "plan/plan-a",
		lastCheckpointCommit: "abc123",
		...statePatch,
	});
	await initializeMemoryFiles(fs, memoryPaths);
	await fs.mkdirp(worktreePath);
	await fs.writeText(
		join(worktreePath, "src/a.ts"),
		"export const value = 1;\n",
	);
	await upsertFileEntries(fs, memoryPaths, [
		{
			path: "src/a.ts",
			kind: "source",
			language: "ts",
			hash: "5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29",
			status: "indexed",
			summary: "A",
		},
	]);
	await writeMemoryCheckpoint(
		fs,
		memoryPaths,
		statePatch.lastCheckpointCommit ?? "abc123",
	);
	await setActivePlan(fs, projectPaths, "plan-a");
	return { fs, projectPaths, planPaths, memoryPaths };
}

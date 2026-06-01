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
import { writeMemoryIndexingState } from "../memory/indexing";
import {
	initializeMemoryFiles,
	upsertFileEntries,
	writeMemoryCheckpoint,
} from "../memory/manager";
import { createMemoryStoragePaths } from "../memory/paths";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
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
	executePlannerWorkflowTool,
	type PlannerWorkflowToolName,
	workflowToolTransition,
} from "./workflow-tools";

describe("planner workflow tools", () => {
	it("maps public workflow tool calls to state transitions", () => {
		expect(transition("planner_start_step")).toEqual({ type: "start_step" });
		expect(transition("planner_advance_step")).toEqual({
			type: "advance_step",
		});
		expect(transition("planner_retry_step")).toEqual({ type: "retry_step" });
		expect(transition("planner_complete_compact")).toEqual({
			type: "complete_compact",
		});
		expect(
			transition("planner_resume_after_recovery", {
				targetStage: "discovery",
				targetStep: "scan_project_structure",
			}),
		).toEqual({
			type: "resume_after_recovery",
			target: { stage: "discovery", step: "scan_project_structure" },
		});
	});

	it("maps complete_step optional next target for decision steps", () => {
		expect(
			transition("planner_finish_step", {
				nextStage: "finalize",
				nextStep: "verify_plan_branch",
			}),
		).toEqual({
			type: "finish_step",
			next: { stage: "finalize", step: "verify_plan_branch" },
		});
		expect(transition("planner_finish_step")).toEqual({
			type: "finish_step",
		});
	});

	it("normalizes reason-bearing workflow tools", () => {
		expect(transition("planner_fail_step", { reason: "tests failed" })).toEqual(
			{
				type: "fail_step",
				reason: "tests failed",
			},
		);
		expect(
			transition("planner_block_step", {
				reason: "needs user",
				requiresUserDecision: true,
			}),
		).toEqual({
			type: "block_step",
			reason: "needs user",
			requiresUserDecision: true,
		});
		expect(
			transition("planner_request_compact", {
				reason: "compact before planning",
			}),
		).toEqual({
			type: "request_compact",
			reason: "compact before planning",
		});
		expect(
			transition("planner_enter_recovery", {
				reason: "wrong branch",
				requiresUserDecision: true,
			}),
		).toEqual({
			type: "enter_recovery",
			reason: "wrong branch",
			requiresUserDecision: true,
		});
	});

	it("executes public workflow tools through preflight and persists state", async () => {
		const setup = await createWorkflowSetup({ stepStatus: "pending" });

		const result = await executePlannerWorkflowTool({
			fs: setup.fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
			toolName: "planner_start_step",
			params: {},
		});

		expect(result.result).toMatchObject({ status: "applied" });
		expect(result.text).toContain("Planner transition applied: start_step");
		expect(await readPlanState(setup.fs, setup.planPaths)).toMatchObject({
			stage: "init",
			step: "check_project",
			stepStatus: "running",
		});
	});

	it("blocks discovery scan completion until a durable indexing queue exists", async () => {
		const setup = await createWorkflowSetup({
			stage: "discovery",
			step: "scan_project_structure",
			stepStatus: "running",
		});

		const result = await executePlannerWorkflowTool({
			fs: setup.fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
			toolName: "planner_finish_step",
			params: {},
		});

		expect(result.result).toMatchObject({
			status: "blocked",
			code: "runtime_blocked",
		});
		expect(result.text).toContain("planner_memory_scan_project");
	});

	it("blocks iterative discovery completion while an active file is incomplete", async () => {
		const setup = await createWorkflowSetup({
			stage: "discovery",
			step: "index_files_iteratively",
			stepStatus: "running",
		});
		await writeMemoryIndexingState(setup.fs, setup.memoryPaths, {
			mode: "initial_discovery",
			activeFile: "src/a.ts",
			files: [
				{
					path: "src/a.ts",
					hash: "hash-a",
					status: "reading",
					lineCount: 10,
					nextUnreadLine: 5,
					candidateSymbolIds: [],
					verificationPassed: false,
					failureReason: null,
				},
			],
		});

		const result = await executePlannerWorkflowTool({
			fs: setup.fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
			toolName: "planner_finish_step",
			params: {},
		});

		expect(result.result).toMatchObject({
			status: "blocked",
			code: "runtime_blocked",
		});
		expect(result.text).toContain("Active file: src/a.ts");
		expect(result.text).toContain("reading=1");
	});

	it("blocks the discovery verification boundary while the durable queue is incomplete", async () => {
		const setup = await createWorkflowSetup({
			stage: "discovery",
			step: "verify_memory",
			stepStatus: "running",
		});

		const result = await executePlannerWorkflowTool({
			fs: setup.fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
			toolName: "planner_finish_step",
			params: {},
		});

		expect(result.result).toMatchObject({
			status: "blocked",
			code: "runtime_blocked",
		});
		expect(result.text).toContain("iterative indexing is incomplete");
		expect(result.text).toContain("planner_memory_index_status");
	});

	it("blocks discovery questions completion while questions.md is empty", async () => {
		const setup = await createWorkflowSetup({
			stage: "discovery",
			step: "write_questions",
			stepStatus: "running",
		});

		const result = await finishStep(setup);

		expect(result.result).toMatchObject({
			status: "blocked",
			code: "runtime_blocked",
		});
		expect(result.text).toContain("/questions.md");
	});

	it("blocks discovery questions completion until submitted questions are resolved", async () => {
		const setup = await createWorkflowSetup({
			stage: "discovery",
			step: "write_questions",
			stepStatus: "running",
			questionsSubmitted: true,
			questionsResolved: false,
		});
		await setup.fs.writeText(
			setup.planPaths.questionsMd,
			"# Questions\n\n1. Which behavior should remain compatible?\n",
		);

		const result = await finishStep(setup);

		expect(result.result).toMatchObject({
			status: "blocked",
			code: "runtime_blocked",
		});
		expect(result.text).toContain("planner_questions_resolve");
	});

	it("finishes discovery questions only after the persisted question gate is resolved", async () => {
		const setup = await createWorkflowSetup({
			stage: "discovery",
			step: "write_questions",
			stepStatus: "running",
			questionsSubmitted: true,
			questionsResolved: true,
		});
		await setup.fs.writeText(
			setup.planPaths.questionsMd,
			"# Questions\n\nNo unresolved questions remain.\n",
		);

		const result = await finishStep(setup);

		expect(result.result).toMatchObject({ status: "applied" });
		await expect(
			readPlanState(setup.fs, setup.planPaths),
		).resolves.toMatchObject({
			stage: "discovery",
			step: "verify_memory",
			stepStatus: "pending",
		});
	});

	it("blocks task preparation completion until a task branch is active", async () => {
		const setup = await createWorkflowSetup({
			stage: "execution",
			step: "prepare_task",
			stepStatus: "running",
		});

		const result = await finishStep(setup);

		expect(result.result).toMatchObject({
			status: "blocked",
			code: "runtime_blocked",
		});
		expect(result.text).toContain("planner_git_create_task_branch");
	});

	it("blocks TDD plan completion while tdd.md is empty", async () => {
		const setup = await createWorkflowSetup({
			stage: "execution",
			step: "write_tdd_plan",
			stepStatus: "running",
			activeTaskId: "task-1",
			activeBranches: {
				base: "main",
				plan: "plan/plan-a",
				currentTask: "plan/plan-a",
				currentExperiment: null,
				selectedExperiment: null,
			},
			managedBranches: {
				tasks: {
					"task-1": {
						task: "plan/plan-a",
						experiments: [],
						selectedExperiment: null,
						refactor: null,
					},
				},
			},
		});

		const result = await finishStep(setup);

		expect(result.result).toMatchObject({
			status: "blocked",
			code: "runtime_blocked",
		});
		expect(result.text).toContain("/tasks/task-1/tdd.md");
	});

	it("blocks experiment execution until an experiment branch is active", async () => {
		const setup = await createWorkflowSetup({
			stage: "execution",
			step: "start_experiments",
			stepStatus: "running",
			activeTaskId: "task-1",
		});

		const result = await finishStep(setup);

		expect(result.result).toMatchObject({
			status: "blocked",
			code: "runtime_blocked",
		});
		expect(result.text).toContain("planner_git_create_experiment_branch");
	});

	it("blocks experiment setup until test edits are committed and checkpointed", async () => {
		const setup = await createWorkflowSetup({
			stage: "execution",
			step: "write_tests",
			stepStatus: "running",
			activeTaskId: "task-1",
		});
		await setup.fs.writeText(
			join(setup.planPaths.tasksDir, "task-1", "tests.md"),
			"# Tests\n\n- src/a.test.ts\n",
		);

		const result = await finishStep(
			setup,
			new MockGitRunner("plan/plan-a", "abc123", " M src/a.test.ts\n"),
		);

		expect(result.result).toMatchObject({
			status: "blocked",
			code: "runtime_blocked",
		});
		expect(result.text).toContain("refresh affected memory");
	});
});

async function finishStep(
	setup: Awaited<ReturnType<typeof createWorkflowSetup>>,
	git: GitRunner = new MockGitRunner(),
) {
	return await executePlannerWorkflowTool({
		fs: setup.fs,
		git,
		projectPaths: setup.projectPaths,
		toolName: "planner_finish_step",
		params: {},
	});
}

function transition(toolName: PlannerWorkflowToolName, params: unknown = {}) {
	return workflowToolTransition(toolName, params);
}

class MockGitRunner implements GitRunner {
	constructor(
		private readonly branch = "plan/plan-a",
		private readonly head = "abc123",
		private readonly status = "",
	) {}

	async init(_input: GitRepoInput): Promise<void> {}
	async currentBranch(_input: GitRepoInput): Promise<string> {
		return this.branch;
	}
	async headCommit(_input: GitRepoInput): Promise<string> {
		return this.head;
	}
	async statusPorcelain(_input: GitRepoInput): Promise<string> {
		return this.status;
	}
	async diffStat(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async diffNameOnly(_input: GitRepoInput): Promise<string> {
		return "";
	}
	async listProjectFiles(_input: GitRepoInput): Promise<string[]> {
		return ["src/a.ts"];
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

async function createWorkflowSetup(statePatch: Partial<PlanStateRecord> = {}) {
	const fs = new MockPlannerFs();
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const memoryPaths = createMemoryStoragePaths(planPaths);
	const worktreePath = "/repo/app/.pi/pi-code-planner/worktrees/plan-a";
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
	await writeMemoryCheckpoint(fs, memoryPaths, "abc123");
	await setActivePlan(fs, projectPaths, "plan-a");
	return { fs, projectPaths, planPaths, memoryPaths };
}

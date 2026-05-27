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
import { DEFAULT_INSTRUCTIONS } from "../instructions/defaults";
import { syncInstructionFiles } from "../instructions/manager";
import { createInstructionPaths } from "../instructions/paths";
import {
	initializeMemoryFiles,
	upsertFileEntries,
	writeMemoryCheckpoint,
} from "../memory/manager";
import {
	createMemoryStoragePaths,
	type MemoryStoragePaths,
} from "../memory/paths";
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
	PLANNER_STAGE_STEPS,
	type PlanStateRecord,
} from "../storage/schema";
import { initializePlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import { runPlannerPreflight } from "./preflight";
import {
	buildPlannerStatusText,
	getPlannerStepRule,
	PLANNER_STATUS_INVARIANTS,
	PLANNER_STEP_RULES,
} from "./status";

describe("planner status text", () => {
	it("has an exact rule for every planner stage step", () => {
		const allSteps = Object.values(PLANNER_STAGE_STEPS).flat();

		expect(Object.keys(PLANNER_STEP_RULES).sort()).toEqual(
			[...allSteps].sort(),
		);
		for (const [stage, steps] of Object.entries(PLANNER_STAGE_STEPS)) {
			for (const step of steps) {
				expect(
					getPlannerStepRule({ stage: stage as never, step }),
				).toMatchObject({ stage, step });
			}
		}
	});

	it("rejects a step rule request with the wrong stage", () => {
		expect(() =>
			getPlannerStepRule({ stage: "planning", step: "read_project" }),
		).toThrow("belongs to discovery");
	});

	it("builds model-facing status with instruction content, artifacts, memory links, invariants, and exact current rule", async () => {
		const fs = new MockPlannerFs();
		const setup = await createStatusSetup(fs, {
			state: {
				stage: "execution",
				step: "write_tests",
				stepStatus: "running",
				activeTaskId: "task-1",
				activeBranches: {
					base: "main",
					plan: "plan/plan-a",
					currentTask: "task/plan-a/task-1",
					currentExperiment: null,
					selectedExperiment: null,
				},
				currentBranch: "task/plan-a/task-1",
			},
		});
		await syncInstructionFiles(fs, createInstructionPaths(setup.projectPaths), {
			...DEFAULT_INSTRUCTIONS,
			execution: "# execution\nExecution default body.\n",
			tdd: "# tdd\nTDD default body.\n",
			memory: "# memory\nMemory default body.\n",
		});
		await fs.writeText(
			join(
				setup.projectPaths.projectLocalDir,
				"instructions",
				"append",
				"tdd.md",
			),
			"Project TDD append.\n",
		);

		const preflight = await runPlannerPreflight({
			fs,
			git: new MockGitRunner({ branch: "task/plan-a/task-1" }),
			projectPaths: setup.projectPaths,
		});
		const text = await buildPlannerStatusText({ fs, preflight });

		expect(text).toContain("# Planner Status");
		expect(text).toContain("- stage: execution");
		expect(text).toContain("- step: write_tests");
		expect(text).toContain(
			"Complete the current step only after exit condition is true: Tests exist and are expected to fail or catch missing behavior.",
		);
		expect(text).toContain("## Current Step Rule");
		expect(text).toContain(
			"- objective: Write failing/mock/contract tests before production implementation.",
		);
		expect(text).toContain("## Stage Behavior");
		expect(text).toContain("- projectAccess: test_edits");
		expect(text).toContain("- requiredArtifacts: tdd.md");
		expect(text).toContain("- commitPolicy: allowed_if_dirty");
		expect(text).toContain("## Instruction Files To Read");
		expect(text).toContain(
			"default: /agent/extensions/pi-code-planner/instructions/defaults/tdd.md",
		);
		expect(text).toContain("## Instruction Bundle");
		expect(text).toContain("Execution default body.");
		expect(text).toContain("TDD default body.");
		expect(text).toContain("Project TDD append.");
		expect(text).toContain("## Planner Artifacts");
		expect(text).toContain("/plans/plan-a/tasks/task-1/tdd.md");
		expect(text).toContain("## Memory-First Rule");
		expect(text).toContain(setup.memoryPaths.symbolsIndexJsonl);
		expect(text).toContain("## Full State Machine Order");
		expect(text).toContain(
			"execution: prepare_task -> write_tdd_plan -> write_tests",
		);
		expect(text).toContain("## Global Invariants");
		expect(text).toContain(PLANNER_STATUS_INVARIANTS[0]);
	});

	it("surfaces memory update gates before normal step instructions", async () => {
		const fs = new MockPlannerFs();
		const setup = await createStatusSetup(fs, {
			state: {
				stage: "execution",
				step: "merge_task_to_plan",
				stepStatus: "running",
				lastCheckpointCommit: "old123",
			},
		});
		await syncInstructionFiles(
			fs,
			createInstructionPaths(setup.projectPaths),
			DEFAULT_INSTRUCTIONS,
		);
		await writeMemoryCheckpoint(fs, setup.memoryPaths, "old123");

		const preflight = await runPlannerPreflight({
			fs,
			git: new MockGitRunner({ head: "new456" }),
			projectPaths: setup.projectPaths,
		});
		const text = await buildPlannerStatusText({ fs, preflight });

		expect(text).toContain("- action: require_memory_update");
		expect(text).toContain(
			"Update planner memory first: inspect/apply freshness, rewrite affected file/symbol/relation/effects entries",
		);
		expect(text).toContain("planner_memory_write_batch");
		expect(text).toContain("memoryUpdateReason: external_commit");
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

async function createStatusSetup(
	fs: MockPlannerFs,
	options: { state?: Partial<PlanStateRecord> } = {},
): Promise<{
	projectPaths: ProjectStoragePaths;
	planPaths: PlanStoragePaths;
	memoryPaths: MemoryStoragePaths;
}> {
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
		stage: "discovery",
		step: "read_project",
		stepStatus: "running",
		currentBranch: "plan/plan-a",
		lastCheckpointCommit: "abc123",
		...options.state,
	});
	await setActivePlan(fs, projectPaths, "plan-a");
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
	return { projectPaths, planPaths, memoryPaths };
}

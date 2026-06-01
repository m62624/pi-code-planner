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
	type PlanStateRecord,
} from "../storage/schema";
import { initializePlanState, readPlanState } from "../storage/state-store";
import { MockPlannerFs } from "../test/mock-fs";
import {
	formatPlannerRecoveryInspection,
	inspectPlannerRecovery,
} from "./recovery";
import {
	executePlannerRecoveryTool,
	type PlannerRecoveryToolExecutionResult,
} from "./recovery-tools";

describe("planner recovery inspection", () => {
	it("treats planner merge head changes as memory update, not external commit recovery", async () => {
		const fs = new MockPlannerFs();
		const setup = await createRecoverySetup(fs, {
			state: {
				stage: "execution",
				step: "merge_task_to_plan",
				stepStatus: "running",
				currentBranch: "plan/plan-a",
				lastCheckpointCommit: "before-merge",
				requiresMemoryUpdate: true,
				memoryUpdateReason: "planner_merge",
			},
			checkpointCommit: "before-merge",
		});

		const inspection = await inspectPlannerRecovery({
			fs,
			git: new MockGitRunner({ head: "merge-commit" }),
			projectPaths: setup.projectPaths,
		});

		expect(issueCodes(inspection)).toContain("memory_update_required");
		expect(issueCodes(inspection)).not.toContain("external_commit");
		expect(inspection.recoveryRequired).toBe(false);
		expect(inspection.recommendedNextAction).toContain(
			"expected after planner commit or merge",
		);
		expect(formatPlannerRecoveryInspection(inspection)).toContain(
			"memoryUpdateReason: planner_merge",
		);
	});

	it("treats planner commit head changes as memory update, not external commit recovery", async () => {
		const fs = new MockPlannerFs();
		const setup = await createRecoverySetup(fs, {
			state: {
				stage: "execution",
				step: "write_tests",
				stepStatus: "running",
				currentBranch: "task/plan-a/task-1",
				lastCheckpointCommit: "before-commit",
				requiresMemoryUpdate: true,
				memoryUpdateReason: "planner_commit",
				activeBranches: {
					base: "main",
					plan: "plan/plan-a",
					currentTask: "task/plan-a/task-1",
					currentExperiment: null,
					selectedExperiment: null,
				},
			},
			checkpointCommit: "before-commit",
		});

		const inspection = await inspectPlannerRecovery({
			fs,
			git: new MockGitRunner({
				branch: "task/plan-a/task-1",
				head: "planner-commit",
			}),
			projectPaths: setup.projectPaths,
		});

		expect(issueCodes(inspection)).toContain("memory_update_required");
		expect(issueCodes(inspection)).not.toContain("external_commit");
		expect(inspection.recoveryRequired).toBe(false);
		expect(formatPlannerRecoveryInspection(inspection)).toContain(
			"memoryUpdateReason: planner_commit",
		);
	});

	it("classifies unexpected head changes as external commit without mutating state files", async () => {
		const fs = new MockPlannerFs();
		const setup = await createRecoverySetup(fs, {
			state: {
				lastCheckpointCommit: "old-head",
				requiresMemoryUpdate: false,
				memoryUpdateReason: null,
			},
			checkpointCommit: "old-head",
		});
		const before = fs.snapshot();

		const inspection = await inspectPlannerRecovery({
			fs,
			git: new MockGitRunner({ head: "new-human-head" }),
			projectPaths: setup.projectPaths,
		});

		expect(issueCodes(inspection)).toContain("external_commit");
		expect(issueCodes(inspection)).not.toContain("memory_update_required");
		expect(inspection.recoveryRequired).toBe(false);
		expect(fs.snapshot()).toEqual(before);
	});

	it("classifies wrong branch and reports the actual branch role", async () => {
		const fs = new MockPlannerFs();
		const setup = await createRecoverySetup(fs, {
			state: {
				stage: "execution",
				step: "run_experiment",
				currentBranch: "experiment/plan-a/task-1/a",
				activeTaskId: "task-1",
				activeExperimentId: "a",
				activeBranches: {
					base: "main",
					plan: "plan/plan-a",
					currentTask: "task/plan-a/task-1",
					currentExperiment: "experiment/plan-a/task-1/a",
					selectedExperiment: null,
				},
				managedBranches: {
					tasks: {
						"task-1": {
							task: "task/plan-a/task-1",
							experiments: ["experiment/plan-a/task-1/a"],
							selectedExperiment: null,
							refactor: null,
						},
					},
				},
			},
		});

		const inspection = await inspectPlannerRecovery({
			fs,
			git: new MockGitRunner({
				branch: "task/plan-a/task-1",
				head: "abc123",
			}),
			projectPaths: setup.projectPaths,
		});

		expect(issueCodes(inspection)).toContain("wrong_branch");
		expect(inspection.recoveryRequired).toBe(true);
		expect(
			inspection.issues.find((issue) => issue.code === "wrong_branch")?.message,
		).toContain("Actual branch role: currentTask");
		expect(inspection.actual.branches).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					branch: "experiment/plan-a/task-1/a",
					role: "currentExperiment",
					exists: true,
				}),
			]),
		);
	});

	it("classifies missing worktree as blocking recovery", async () => {
		const fs = new MockPlannerFs();
		const setup = await createRecoverySetup(fs, { createWorktree: false });

		const inspection = await inspectPlannerRecovery({
			fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
		});

		expect(issueCodes(inspection)).toContain("missing_worktree");
		expect(inspection.recoveryRequired).toBe(true);
		expect(inspection.actual.git).toBeNull();
	});

	it("classifies memory checkpoint corruption as blocking recovery", async () => {
		const fs = new MockPlannerFs();
		const setup = await createRecoverySetup(fs);
		await upsertFileEntries(fs, setup.memoryPaths, [
			{
				path: "src/a.ts",
				kind: "source",
				language: "ts",
				hash: "changed-after-checkpoint",
				status: "indexed",
				summary: "A",
			},
		]);

		const inspection = await inspectPlannerRecovery({
			fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
		});

		expect(issueCodes(inspection)).toContain("memory_checkpoint_corrupt");
		expect(inspection.recoveryRequired).toBe(true);
		expect(inspection.destructiveOptions.join("\n")).toContain(
			"Regenerate or delete corrupted memory files",
		);
	});

	it("executes public recovery inspect only when policy allows recovery tools", async () => {
		const fs = new MockPlannerFs();
		const setup = await createRecoverySetup(fs);

		const blocked = await executePlannerRecoveryTool({
			fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
			toolName: "planner_recovery_inspect",
			params: {},
		});
		expect(blocked.status).toBe("blocked");

		const recoveryFs = new MockPlannerFs();
		const recoverySetup = await createRecoverySetup(recoveryFs, {
			state: {
				currentBranch: "task/plan-a/task-1",
			},
		});
		const applied = (await executePlannerRecoveryTool({
			fs: recoveryFs,
			git: new MockGitRunner({ branch: "main" }),
			projectPaths: recoverySetup.projectPaths,
			toolName: "planner_recovery_inspect",
			params: {},
		})) as PlannerRecoveryToolExecutionResult;

		expect(applied.status).toBe("applied");
		expect(applied.text).toContain("# Planner Recovery Inspection");
		expect(applied.text).toContain("wrong_branch");
	});

	it("resumes recovery when only state gate issues remain", async () => {
		const fs = new MockPlannerFs();
		const setup = await createRecoverySetup(fs, {
			state: {
				stage: "recovery",
				step: "read_state",
				stepStatus: "blocked",
				broken: true,
				brokenReason: "user reviewed recovery report",
				requiresUserDecision: true,
			},
		});

		const result = await executePlannerRecoveryTool({
			fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
			toolName: "planner_recovery_resume",
			params: {
				targetStage: "discovery",
				targetStep: "scan_project_structure",
			},
		});

		expect(result.status).toBe("applied");
		expect(result.text).toContain("Planner recovery resumed");
		expect(await readPlanState(fs, setup.planPaths)).toMatchObject({
			stage: "discovery",
			step: "scan_project_structure",
			stepStatus: "pending",
			broken: false,
			requiresUserDecision: false,
			requiresMemoryUpdate: false,
		});
	});

	it("blocks recovery resume while actual git branch is still wrong", async () => {
		const fs = new MockPlannerFs();
		const setup = await createRecoverySetup(fs, {
			state: {
				stage: "recovery",
				step: "read_state",
				stepStatus: "blocked",
				broken: true,
				brokenReason: "wrong branch",
				requiresUserDecision: true,
			},
		});
		const before = await readPlanState(fs, setup.planPaths);

		const result = await executePlannerRecoveryTool({
			fs,
			git: new MockGitRunner({ branch: "main" }),
			projectPaths: setup.projectPaths,
			toolName: "planner_recovery_resume",
			params: {
				targetStage: "discovery",
				targetStep: "scan_project_structure",
			},
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("wrong_branch");
		expect(await readPlanState(fs, setup.planPaths)).toEqual(before);
	});

	it("blocks recovery resume to an invalid target stage and step", async () => {
		const fs = new MockPlannerFs();
		const setup = await createRecoverySetup(fs, {
			state: {
				stage: "recovery",
				step: "read_state",
				stepStatus: "blocked",
				broken: true,
				brokenReason: "user reviewed recovery report",
				requiresUserDecision: true,
			},
		});
		const before = await readPlanState(fs, setup.planPaths);

		const result = await executePlannerRecoveryTool({
			fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
			toolName: "planner_recovery_resume",
			params: { targetStage: "done", targetStep: "scan_project_structure" },
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("Invalid recovery resume target");
		expect(await readPlanState(fs, setup.planPaths)).toEqual(before);
	});

	it("resumes recovery with memory update gate after an external commit", async () => {
		const fs = new MockPlannerFs();
		const setup = await createRecoverySetup(fs, {
			state: {
				stage: "recovery",
				step: "read_state",
				stepStatus: "blocked",
				broken: true,
				brokenReason: "external commit needs review",
				requiresUserDecision: true,
				lastCheckpointCommit: "old-head",
				requiresMemoryUpdate: false,
				memoryUpdateReason: null,
			},
			checkpointCommit: "old-head",
		});

		const result = await executePlannerRecoveryTool({
			fs,
			git: new MockGitRunner({ head: "new-head" }),
			projectPaths: setup.projectPaths,
			toolName: "planner_recovery_resume",
			params: {
				targetStage: "discovery",
				targetStep: "scan_project_structure",
			},
		});

		expect(result.status).toBe("applied");
		expect(await readPlanState(fs, setup.planPaths)).toMatchObject({
			stage: "discovery",
			step: "scan_project_structure",
			stepStatus: "pending",
			broken: false,
			requiresUserDecision: false,
			requiresMemoryUpdate: true,
			memoryUpdateReason: "external_commit",
		});
	});
});

function issueCodes(inspection: {
	issues: readonly { code: string }[];
}): string[] {
	return inspection.issues.map((issue) => issue.code);
}

class MockGitRunner implements GitRunner {
	constructor(
		private readonly input: {
			branch?: string;
			head?: string;
			status?: string;
			branches?: Record<string, boolean>;
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
		return ["src/a.ts"];
	}
	async branchExists(input: GitBranchInput): Promise<boolean> {
		return this.input.branches?.[input.branch] ?? true;
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

async function createRecoverySetup(
	fs: MockPlannerFs,
	options: {
		state?: Partial<PlanStateRecord>;
		createWorktree?: boolean;
		checkpointCommit?: string;
	} = {},
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
		step: "scan_project_structure",
		stepStatus: "running",
		currentBranch: "plan/plan-a",
		lastCheckpointCommit: "abc123",
		...options.state,
	});
	await setActivePlan(fs, projectPaths, "plan-a");
	await initializeMemoryFiles(fs, memoryPaths);
	if (options.createWorktree ?? true) {
		await fs.writeText(
			join(worktreePath, "src/a.ts"),
			"export const value = 1;\n",
		);
	}
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
		options.checkpointCommit ?? "abc123",
	);
	return { projectPaths, planPaths, memoryPaths };
}

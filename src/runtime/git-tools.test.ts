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
	writeMemoryCheckpoint,
} from "../memory/manager";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
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
import { executePlannerGitTool } from "./git-tools";

class MockGitRunner implements GitRunner {
	readonly calls: Array<{ name: string; input: unknown }> = [];
	branch: string;
	head: string;
	status: string;
	files: string[];

	constructor(
		input: {
			branch?: string;
			head?: string;
			status?: string;
			files?: string[];
		} = {},
	) {
		this.branch = input.branch ?? "plan/plan-a";
		this.head = input.head ?? "abc123";
		this.status = input.status ?? "";
		this.files = input.files ?? [];
	}

	async init(input: GitRepoInput): Promise<void> {
		this.calls.push({ name: "init", input });
	}
	async currentBranch(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "currentBranch", input });
		return this.branch;
	}
	async headCommit(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "headCommit", input });
		return this.head;
	}
	async statusPorcelain(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "statusPorcelain", input });
		return this.status;
	}
	async diffStat(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "diffStat", input });
		return "";
	}
	async diffNameOnly(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "diffNameOnly", input });
		return "";
	}
	async listProjectFiles(input: GitRepoInput): Promise<string[]> {
		this.calls.push({ name: "listProjectFiles", input });
		return this.files;
	}
	async branchExists(input: GitBranchInput): Promise<boolean> {
		this.calls.push({ name: "branchExists", input });
		return true;
	}
	async createBranch(input: GitCreateBranchInput): Promise<void> {
		this.calls.push({ name: "createBranch", input });
		this.branch = input.branch;
	}
	async deleteBranch(input: GitDeleteBranchInput): Promise<void> {
		this.calls.push({ name: "deleteBranch", input });
	}
	async switchBranch(input: GitSwitchBranchInput): Promise<void> {
		this.calls.push({ name: "switchBranch", input });
		this.branch = input.branch;
	}
	async stageAll(input: GitRepoInput): Promise<void> {
		this.calls.push({ name: "stageAll", input });
	}
	async commit(input: GitCommitInput): Promise<void> {
		this.calls.push({ name: "commit", input });
		this.head = "new456";
		this.status = "";
	}
	async merge(input: GitMergeInput): Promise<void> {
		this.calls.push({ name: "merge", input });
		this.head = "merge789";
		this.status = "";
	}
	async worktreeAdd(input: GitWorktreeAddInput): Promise<void> {
		this.calls.push({ name: "worktreeAdd", input });
		this.branch = input.branch;
	}
	async worktreeRemove(input: GitWorktreeRemoveInput): Promise<void> {
		this.calls.push({ name: "worktreeRemove", input });
	}
}

describe("planner git tools", () => {
	it("commits through planner git and marks memory update required", async () => {
		const fs = new MockPlannerFs();
		const setup = await createGitToolSetup(fs, {
			state: {
				stage: "execution",
				step: "write_tests",
				stepStatus: "running",
				currentBranch: "task/plan-a/task-1",
				lastCheckpointCommit: "old123",
				activeBranches: {
					base: "main",
					plan: "plan/plan-a",
					currentTask: "task/plan-a/task-1",
					currentExperiment: null,
					selectedExperiment: null,
				},
			},
			checkpointCommit: "old123",
		});
		const git = new MockGitRunner({
			branch: "task/plan-a/task-1",
			head: "old123",
			status: " M src/a.ts",
		});

		const result = await executePlannerGitTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_git_commit",
			params: { message: "add failing tests" },
		});

		expect(result.status).toBe("applied");
		expect(git.calls.map((call) => call.name)).toContain("stageAll");
		expect(git.calls).toContainEqual({
			name: "commit",
			input: {
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				message: "add failing tests",
			},
		});
		expect(await readPlanState(fs, setup.planPaths)).toMatchObject({
			currentBranch: "task/plan-a/task-1",
			lastCheckpointCommit: "old123",
			requiresMemoryUpdate: true,
			memoryUpdateReason: "planner_commit",
		});
	});

	it("blocks planner git commit when there are no changes to commit", async () => {
		const fs = new MockPlannerFs();
		const setup = await createGitToolSetup(fs, {
			state: {
				stage: "execution",
				step: "write_tests",
				stepStatus: "running",
				currentBranch: "task/plan-a/task-1",
				lastCheckpointCommit: "abc123",
				activeBranches: {
					base: "main",
					plan: "plan/plan-a",
					currentTask: "task/plan-a/task-1",
					currentExperiment: null,
					selectedExperiment: null,
				},
			},
		});
		const git = new MockGitRunner({
			branch: "task/plan-a/task-1",
			head: "abc123",
			status: "",
		});
		const before = await readPlanState(fs, setup.planPaths);

		const result = await executePlannerGitTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_git_commit",
			params: { message: "empty commit should not happen" },
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("no changes to commit");
		expect(git.calls.map((call) => call.name)).not.toContain("stageAll");
		expect(git.calls.map((call) => call.name)).not.toContain("commit");
		expect(await readPlanState(fs, setup.planPaths)).toEqual(before);
	});

	it("keeps merge targets state-bound when merging selected experiment", async () => {
		const fs = new MockPlannerFs();
		const setup = await createGitToolSetup(fs, {
			state: {
				stage: "execution",
				step: "merge_best_experiment",
				stepStatus: "running",
				activeTaskId: "task-1",
				activeExperimentId: "attempt-a",
				currentBranch: "experiment/plan-a/task-1/attempt-a",
				activeBranches: {
					base: "main",
					plan: "plan/plan-a",
					currentTask: "task/plan-a/task-1",
					currentExperiment: "experiment/plan-a/task-1/attempt-a",
					selectedExperiment: "experiment/plan-a/task-1/attempt-a",
				},
				mergeTargets: {
					experimentToTask: "task/plan-a/task-1",
					taskToPlan: "plan/plan-a",
					planToOutput: null,
				},
			},
		});
		const git = new MockGitRunner({
			branch: "experiment/plan-a/task-1/attempt-a",
			head: "abc123",
		});

		const result = await executePlannerGitTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_git_merge_selected_experiment",
			params: { message: "merge attempt-a" },
		});

		expect(result.status).toBe("applied");
		expect(git.calls).toContainEqual({
			name: "switchBranch",
			input: {
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				branch: "task/plan-a/task-1",
			},
		});
		expect(git.calls).toContainEqual({
			name: "merge",
			input: {
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				sourceBranch: "experiment/plan-a/task-1/attempt-a",
				noFastForward: true,
				message: "merge attempt-a",
			},
		});
		expect(await readPlanState(fs, setup.planPaths)).toMatchObject({
			currentBranch: "task/plan-a/task-1",
			requiresMemoryUpdate: true,
			memoryUpdateReason: "planner_merge",
			mergeTargets: { experimentToTask: null },
		});
	});

	it("blocks git wrappers outside their policy step", async () => {
		const fs = new MockPlannerFs();
		const setup = await createGitToolSetup(fs, {
			state: {
				stage: "execution",
				step: "prepare_task",
				stepStatus: "running",
			},
		});

		const result = await executePlannerGitTool({
			fs,
			git: new MockGitRunner(),
			projectPaths: setup.projectPaths,
			toolName: "planner_git_commit",
			params: { message: "should not commit" },
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("blocked");
	});

	it("cleans only managed child branches and never deletes the protected plan branch", async () => {
		const fs = new MockPlannerFs();
		const setup = await createGitToolSetup(fs, {
			state: {
				stage: "done",
				step: "cleanup_worktree",
				stepStatus: "running",
				activeBranches: {
					base: "main",
					plan: "plan/plan-a",
					currentTask: "task/plan-a/task-1",
					currentExperiment: "experiment/plan-a/task-1/attempt-a",
					selectedExperiment: "experiment/plan-a/task-1/attempt-a",
				},
			},
		});
		const git = new MockGitRunner();

		const result = await executePlannerGitTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_git_cleanup_managed_branches",
			params: { force: true },
		});

		expect(result.status).toBe("applied");
		expect(git.calls.filter((call) => call.name === "deleteBranch")).toEqual([
			{
				name: "deleteBranch",
				input: {
					repoRoot: "/repo/app",
					branch: "experiment/plan-a/task-1/attempt-a",
					force: true,
				},
			},
			{
				name: "deleteBranch",
				input: {
					repoRoot: "/repo/app",
					branch: "task/plan-a/task-1",
					force: true,
				},
			},
		]);
		expect(git.calls).not.toContainEqual({
			name: "deleteBranch",
			input: { repoRoot: "/repo/app", branch: "plan/plan-a", force: true },
		});
	});
});

async function createGitToolSetup(
	fs: MockPlannerFs,
	input: {
		state?: Partial<PlanStateRecord>;
		checkpointCommit?: string;
		createWorktreeDir?: boolean;
		initializeMemory?: boolean;
	} = {},
): Promise<{
	projectPaths: ProjectStoragePaths;
	planPaths: ReturnType<typeof createPlanStoragePaths>;
}> {
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
	await initializePlanState(fs, planPaths, {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath,
		}),
		currentBranch: "plan/plan-a",
		lastCheckpointCommit: input.checkpointCommit ?? "abc123",
		...input.state,
	});
	if (input.createWorktreeDir ?? true) {
		await fs.mkdirp(worktreePath);
		await fs.writeText(join(worktreePath, "src/a.ts"), "");
	}
	if (input.initializeMemory ?? true) {
		const memoryPaths = await initializeMemoryFiles(fs, planPaths);
		await writeMemoryCheckpoint(
			fs,
			memoryPaths,
			input.checkpointCommit ?? "abc123",
		);
	}
	await setActivePlan(fs, projectPaths, "plan-a");
	return { projectPaths, planPaths };
}

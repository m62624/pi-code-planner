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
	it("commits through planner git and persists synchronized state", async () => {
		const fs = new MockPlannerFs();
		const setup = await createGitToolSetup(fs, {
			state: {
				stage: "execution",
				step: "write_tests",
				stepStatus: "running",
				currentBranch: "task/plan-a/task-1",
				activeBranches: {
					base: "main",
					plan: "plan/plan-a",
					currentTask: "task/plan-a/task-1",
				},
			},
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
				activeBranches: {
					base: "main",
					plan: "plan/plan-a",
					currentTask: "task/plan-a/task-1",
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

	it("blocks planner git commit while debug artifacts exist", async () => {
		const fs = new MockPlannerFs();
		const debugArtifactsDir =
			"/repo/app/.pi/pi-code-planner/worktrees/plan-a/.pi/pi-code-planner/debug/task-1/attempt-001-deadbeef";
		const setup = await createGitToolSetup(fs, {
			state: {
				stage: "execution",
				step: "implement_task",
				stepStatus: "running",
				currentBranch: "task/plan-a/task-1",
				activeBranches: {
					base: "main",
					plan: "plan/plan-a",
					currentTask: "task/plan-a/task-1",
				},
				lastStuckAttemptId: "attempt-001",
				debugSessionId: "attempt-001-deadbeef",
				debugArtifactsDir,
				debugCleanupRequired: true,
			},
		});
		await fs.mkdirp(debugArtifactsDir);
		await fs.writeTextAtomic(`${debugArtifactsDir}/probe.md`, "debug\n");
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
			params: { message: "must wait" },
		});

		expect(result.status).toBe("blocked");
		expect(result.text).toContain("debug artifacts still exist");
		expect(git.calls.map((call) => call.name)).not.toContain("stageAll");
		expect(git.calls.map((call) => call.name)).not.toContain("commit");
	});

	it("keeps merge targets state-bound when merging task into plan", async () => {
		const fs = new MockPlannerFs();
		const setup = await createGitToolSetup(fs, {
			state: {
				stage: "execution",
				step: "merge_task_to_plan",
				stepStatus: "running",
				activeTaskId: "task-1",
				currentBranch: "task/plan-a/task-1",
				activeBranches: {
					base: "main",
					plan: "plan/plan-a",
					currentTask: "task/plan-a/task-1",
				},
				mergeTargets: {
					taskToPlan: "plan/plan-a",
					planToOutput: null,
				},
			},
		});
		const git = new MockGitRunner({
			branch: "task/plan-a/task-1",
			head: "abc123",
		});

		const result = await executePlannerGitTool({
			fs,
			git,
			projectPaths: setup.projectPaths,
			toolName: "planner_git_merge_task_to_plan",
			params: { message: "merge task-1" },
		});

		expect(result.status).toBe("applied");
		expect(git.calls).toContainEqual({
			name: "switchBranch",
			input: {
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				branch: "plan/plan-a",
			},
		});
		expect(git.calls).toContainEqual({
			name: "merge",
			input: {
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				sourceBranch: "task/plan-a/task-1",
				noFastForward: true,
				message: "merge task-1",
			},
		});
		expect(await readPlanState(fs, setup.planPaths)).toMatchObject({
			currentBranch: "plan/plan-a",
			activeTaskId: null,
			mergeTargets: { taskToPlan: null },
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
});

async function createGitToolSetup(
	fs: MockPlannerFs,
	input: {
		state?: Partial<PlanStateRecord>;
		createWorktreeDir?: boolean;
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
		...input.state,
	});
	if (input.createWorktreeDir ?? true) {
		await fs.mkdirp(worktreePath);
		await fs.writeText(join(worktreePath, "src/a.ts"), "");
	}
	await setActivePlan(fs, projectPaths, "plan-a");
	return { projectPaths, planPaths };
}

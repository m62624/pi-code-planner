import { describe, expect, it } from "vitest";
import {
	createInitialPlanState,
	type PlanStateRecord,
} from "../storage/schema";
import {
	createAndSwitchExperimentBranch,
	createAndSwitchRefactorBranch,
	createAndSwitchTaskBranch,
	deleteManagedBranch,
	exportPlanToOutputBranch,
	mergeRefactorToTask,
	mergeSelectedExperimentToTask,
	mergeTaskToPlan,
	selectExperiment,
} from "./planner-ops";
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
} from "./runner";

class MockGitRunner implements GitRunner {
	readonly calls: Array<{ name: string; input: unknown }> = [];

	async init(input: GitRepoInput): Promise<void> {
		this.calls.push({ name: "init", input });
	}
	async currentBranch(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "currentBranch", input });
		return "main";
	}
	async headCommit(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "headCommit", input });
		return "abc123";
	}
	async statusPorcelain(input: GitRepoInput): Promise<string> {
		this.calls.push({ name: "statusPorcelain", input });
		return "";
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
		return [];
	}
	async branchExists(input: GitBranchInput): Promise<boolean> {
		this.calls.push({ name: "branchExists", input });
		return true;
	}
	async createBranch(input: GitCreateBranchInput): Promise<void> {
		this.calls.push({ name: "createBranch", input });
	}
	async deleteBranch(input: GitDeleteBranchInput): Promise<void> {
		this.calls.push({ name: "deleteBranch", input });
	}
	async switchBranch(input: GitSwitchBranchInput): Promise<void> {
		this.calls.push({ name: "switchBranch", input });
	}
	async stageAll(input: GitRepoInput): Promise<void> {
		this.calls.push({ name: "stageAll", input });
	}
	async commit(input: GitCommitInput): Promise<void> {
		this.calls.push({ name: "commit", input });
	}
	async merge(input: GitMergeInput): Promise<void> {
		this.calls.push({ name: "merge", input });
	}
	async worktreeAdd(input: GitWorktreeAddInput): Promise<void> {
		this.calls.push({ name: "worktreeAdd", input });
	}
	async worktreeRemove(input: GitWorktreeRemoveInput): Promise<void> {
		this.calls.push({ name: "worktreeRemove", input });
	}
}

function baseState(): PlanStateRecord {
	return {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		}),
		currentBranch: "plan/plan-a",
	};
}

describe("planner git operations", () => {
	it("creates task branch from plan branch and stores merge target in state", async () => {
		const git = new MockGitRunner();

		const result = await createAndSwitchTaskBranch({
			git,
			state: baseState(),
			planId: "plan-a",
			taskId: "task-1",
		});

		expect(result.state.activeBranches.currentTask).toBe("task/plan-a/task-1");
		expect(result.state.mergeTargets.taskToPlan).toBe("plan/plan-a");
		expect(git.calls).toEqual([
			{
				name: "createBranch",
				input: {
					repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
					branch: "task/plan-a/task-1",
					fromRef: "plan/plan-a",
				},
			},
			{
				name: "switchBranch",
				input: {
					repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
					branch: "task/plan-a/task-1",
				},
			},
		]);
	});

	it("creates experiment branch from current task and merges selected experiment into task", async () => {
		const git = new MockGitRunner();
		const task = (
			await createAndSwitchTaskBranch({
				git,
				state: baseState(),
				planId: "plan-a",
				taskId: "task-1",
			})
		).state;

		const experiment = (
			await createAndSwitchExperimentBranch({
				git,
				state: task,
				planId: "plan-a",
				taskId: "task-1",
				attemptId: "attempt-a",
			})
		).state;
		const secondExperiment = (
			await createAndSwitchExperimentBranch({
				git,
				state: experiment,
				planId: "plan-a",
				taskId: "task-1",
				attemptId: "attempt-b",
			})
		).state;
		const selected = (
			await selectExperiment({
				state: secondExperiment,
				planId: "plan-a",
				taskId: "task-1",
				attemptId: "attempt-a",
			})
		).state;
		const merged = (
			await mergeSelectedExperimentToTask({
				git,
				state: selected,
				message: "merge selected experiment",
			})
		).state;

		expect(selected.activeBranches.selectedExperiment).toBe(
			"experiment/plan-a/task-1/attempt-a",
		);
		expect(merged.currentBranch).toBe("task/plan-a/task-1");
		expect(merged.mergeTargets.experimentToTask).toBeNull();
		expect(merged.managedBranches.tasks["task-1"]).toMatchObject({
			experiments: [],
			selectedExperiment: null,
		});
		expect(git.calls.slice(-4)).toEqual([
			{
				name: "switchBranch",
				input: {
					repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
					branch: "task/plan-a/task-1",
				},
			},
			{
				name: "merge",
				input: {
					repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
					sourceBranch: "experiment/plan-a/task-1/attempt-a",
					noFastForward: true,
					message: "merge selected experiment",
				},
			},
			{
				name: "deleteBranch",
				input: {
					repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
					branch: "experiment/plan-a/task-1/attempt-a",
					force: true,
				},
			},
			{
				name: "deleteBranch",
				input: {
					repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
					branch: "experiment/plan-a/task-1/attempt-b",
					force: true,
				},
			},
		]);
	});

	it("merges refactor branch into task, then task into plan", async () => {
		const git = new MockGitRunner();
		const task = (
			await createAndSwitchTaskBranch({
				git,
				state: baseState(),
				planId: "plan-a",
				taskId: "task-1",
			})
		).state;
		const refactor = (
			await createAndSwitchRefactorBranch({
				git,
				state: task,
				planId: "plan-a",
				taskId: "task-1",
			})
		).state;
		const refactorMerged = (
			await mergeRefactorToTask({
				git,
				state: refactor,
				planId: "plan-a",
				taskId: "task-1",
				message: "merge refactor",
			})
		).state;
		const planMerged = (
			await mergeTaskToPlan({
				git,
				state: refactorMerged,
				message: "merge task",
			})
		).state;

		expect(planMerged.currentBranch).toBe("plan/plan-a");
		expect(planMerged.activeBranches.currentTask).toBeNull();
		expect(planMerged.activeTaskId).toBeNull();
		expect(planMerged.managedBranches.tasks["task-1"]).toBeUndefined();
		expect(git.calls.at(-2)).toEqual({
			name: "merge",
			input: {
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				sourceBranch: "task/plan-a/task-1",
				noFastForward: true,
				message: "merge task",
			},
		});
		expect(git.calls.at(-1)).toEqual({
			name: "deleteBranch",
			input: {
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				branch: "task/plan-a/task-1",
				force: false,
			},
		});
	});

	it("exports plan to output branch in original repo", async () => {
		const git = new MockGitRunner();

		const result = await exportPlanToOutputBranch({
			git,
			state: baseState(),
			projectRoot: "/repo/app",
			planId: "plan-a",
			message: "export plan",
		});

		expect(result.state.mergeTargets.planToOutput).toBe("output/plan-a");
		expect(git.calls).toEqual([
			{
				name: "createBranch",
				input: {
					repoRoot: "/repo/app",
					branch: "output/plan-a",
					fromRef: "main",
				},
			},
			{
				name: "switchBranch",
				input: { repoRoot: "/repo/app", branch: "output/plan-a" },
			},
			{
				name: "merge",
				input: {
					repoRoot: "/repo/app",
					sourceBranch: "plan/plan-a",
					noFastForward: true,
					message: "export plan",
				},
			},
		]);
	});

	it("blocks direct deletion of plan branches", async () => {
		const git = new MockGitRunner();

		await expect(
			deleteManagedBranch({
				git,
				repoRoot: "/repo/app",
				branch: "plan/plan-a",
			}),
		).rejects.toThrow("Plan branch is protected");
		expect(git.calls).toEqual([]);
	});
});

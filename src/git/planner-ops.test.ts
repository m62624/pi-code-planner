import { describe, expect, it } from "vitest";
import {
	createInitialPlanState,
	type PlanStateRecord,
} from "../storage/schema";
import {
	createAndSwitchRefactorBranch,
	createAndSwitchTaskBranch,
	deleteManagedBranch,
	exportPlanToOutputBranch,
	mergeRefactorToTask,
	mergeTaskToPlan,
	PlanExportConflictError,
	parseUnmergedFiles,
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
	mergeError: Error | null = null;
	statusPorcelainResult = "";

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
		return this.statusPorcelainResult;
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
		if (this.mergeError) {
			throw this.mergeError;
		}
	}
	async mergeAbort(input: GitRepoInput): Promise<void> {
		this.calls.push({ name: "mergeAbort", input });
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

	it("rolls the worktree back to the task branch when the task→plan merge fails", async () => {
		const git = new MockGitRunner();
		const task = (
			await createAndSwitchTaskBranch({
				git,
				state: baseState(),
				planId: "plan-a",
				taskId: "task-1",
			})
		).state;
		git.calls.length = 0;
		git.mergeError = new Error("merge failed");

		const error = await mergeTaskToPlan({
			git,
			state: task,
			message: "merge task",
		}).catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(Error);
		// Switched to plan to merge, the merge threw, then we abort the partial
		// merge and return to the task branch so git matches the unchanged state.
		expect(git.calls.map((call) => call.name)).toEqual([
			"switchBranch",
			"merge",
			"mergeAbort",
			"switchBranch",
		]);
		expect(git.calls.at(-1)).toEqual({
			name: "switchBranch",
			input: {
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				branch: "task/plan-a/task-1",
			},
		});
		// No branch deletions happened on the failure path.
		expect(git.calls.some((call) => call.name === "deleteBranch")).toBe(false);
	});

	it("rolls the worktree back to the refactor branch when the refactor→task merge fails", async () => {
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
		git.calls.length = 0;
		git.mergeError = new Error("merge failed");

		const error = await mergeRefactorToTask({
			git,
			state: refactor,
			planId: "plan-a",
			taskId: "task-1",
			message: "merge refactor",
		}).catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(Error);
		expect(git.calls.map((call) => call.name)).toEqual([
			"switchBranch",
			"merge",
			"mergeAbort",
			"switchBranch",
		]);
		expect(git.calls.at(-1)).toEqual({
			name: "switchBranch",
			input: {
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
				branch: "refactor/plan-a/task-1",
			},
		});
		expect(git.calls.some((call) => call.name === "deleteBranch")).toBe(false);
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

	it("rolls back and reports conflicts when the export merge fails", async () => {
		const git = new MockGitRunner();
		const mergeError = Object.assign(new Error("git merge failed"), {
			stderr:
				"Auto-merging .gitignore\nCONFLICT (content): Merge conflict in .gitignore\nAutomatic merge failed; fix conflicts and then commit the result.",
		});
		git.mergeError = mergeError;
		git.statusPorcelainResult = "UU .gitignore\nA  AGENTS.md\n";

		const error = await exportPlanToOutputBranch({
			git,
			state: baseState(),
			projectRoot: "/repo/app",
			planId: "plan-a",
			message: "export plan",
		}).catch((thrown: unknown) => thrown);

		expect(error).toBeInstanceOf(PlanExportConflictError);
		const conflict = error as PlanExportConflictError;
		expect(conflict.details.conflictFiles).toEqual([".gitignore"]);
		expect(conflict.details.outputBranch).toBe("output/plan-a");
		expect(conflict.details.baseBranch).toBe("main");
		expect(conflict.message).toContain(".gitignore");
		expect(conflict.message).toContain("Merge conflict in .gitignore");

		const callNames = git.calls.map((call) => call.name);
		// Rollback happened in order after the failed merge: abort, return to
		// base, delete the freshly created output branch.
		expect(callNames).toEqual([
			"createBranch",
			"switchBranch",
			"merge",
			"statusPorcelain",
			"mergeAbort",
			"switchBranch",
			"deleteBranch",
		]);
		expect(git.calls.at(-2)).toEqual({
			name: "switchBranch",
			input: { repoRoot: "/repo/app", branch: "main" },
		});
		expect(git.calls.at(-1)).toEqual({
			name: "deleteBranch",
			input: { repoRoot: "/repo/app", branch: "output/plan-a", force: true },
		});
	});

	it("parses unmerged files from porcelain status", () => {
		const porcelain = [
			"UU .gitignore",
			"A  AGENTS.md",
			"AA both-added.txt",
			"DD both-deleted.txt",
			"M  staged.ts",
			" M dirty.ts",
			"?? untracked.ts",
		].join("\n");
		expect(parseUnmergedFiles(porcelain)).toEqual([
			".gitignore",
			"both-added.txt",
			"both-deleted.txt",
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

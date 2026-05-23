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
import { createInitialPlanState } from "../storage/schema";
import {
	evaluatePlannerToolPreflight,
	inspectPlannerGitReality,
	markMemoryCheckpointSynced,
	type PlannerGitReality,
	runSyncedPlannerGitMutation,
	syncStateAfterPlannerGitMutation,
} from "./git-state-sync";

class MockGitRunner implements GitRunner {
	constructor(
		private branch: string,
		private head: string,
		private status: string,
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

	setHead(head: string): void {
		this.head = head;
	}
}

describe("planner git state sync", () => {
	it("inspects actual branch, head, dirty state, and conflicts before tool execution", async () => {
		const git = new MockGitRunner("plan/plan-a", "abc123", "UU src/a.ts\n");

		const reality = await inspectPlannerGitReality({
			git,
			repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		});

		expect(reality).toEqual({
			repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			branch: "plan/plan-a",
			headCommit: "abc123",
			statusPorcelain: "UU src/a.ts\n",
			isDirty: true,
			hasConflicts: true,
		});
	});

	it("allows normal tool execution when branch, head, and memory checkpoint match", () => {
		const state = {
			...baseState(),
			currentBranch: "plan/plan-a",
			lastCheckpointCommit: "abc123",
		};

		expect(
			evaluatePlannerToolPreflight({
				state,
				reality: reality({ branch: "plan/plan-a", headCommit: "abc123" }),
			}),
		).toEqual({ action: "allow", reason: null });
	});

	it("requires memory update when head differs from last memory checkpoint", () => {
		const state = {
			...baseState(),
			currentBranch: "plan/plan-a",
			lastCheckpointCommit: "old123",
		};

		expect(
			evaluatePlannerToolPreflight({
				state,
				reality: reality({ branch: "plan/plan-a", headCommit: "new456" }),
			}),
		).toMatchObject({
			action: "require_memory_update",
			reason: "HEAD new456 differs from memory checkpoint old123.",
		});
	});

	it("requires recovery on wrong branch or conflicts", () => {
		const state = {
			...baseState(),
			currentBranch: "plan/plan-a",
			lastCheckpointCommit: "abc123",
		};

		expect(
			evaluatePlannerToolPreflight({
				state,
				reality: reality({ branch: "task/plan-a/task-1" }),
			}),
		).toMatchObject({ action: "require_recovery" });
		expect(
			evaluatePlannerToolPreflight({
				state,
				reality: reality({ branch: "plan/plan-a", statusPorcelain: "UU a.ts" }),
			}),
		).toMatchObject({ action: "require_recovery" });
	});

	it("syncs state after planner git mutation without advancing memory checkpoint", () => {
		const state = {
			...baseState(),
			currentBranch: "task/plan-a/task-1",
			lastCheckpointCommit: "old123",
		};
		const synced = syncStateAfterPlannerGitMutation({
			state,
			before: reality({ branch: "task/plan-a/task-1", headCommit: "old123" }),
			after: reality({ branch: "task/plan-a/task-1", headCommit: "new456" }),
			headChangeReason: "planner_commit",
		});

		expect(synced).toMatchObject({
			currentBranch: "task/plan-a/task-1",
			lastCheckpointCommit: "old123",
			requiresMemoryUpdate: true,
			memoryUpdateReason: "planner_commit",
		});
	});

	it("runs git mutation between before and after inspections and returns synced state", async () => {
		const git = new MockGitRunner("task/plan-a/task-1", "old123", "");
		const state = {
			...baseState(),
			currentBranch: "task/plan-a/task-1",
			lastCheckpointCommit: "old123",
		};

		const synced = await runSyncedPlannerGitMutation({
			git,
			state,
			repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			headChangeReason: "planner_commit",
			async mutate() {
				git.setHead("new456");
				return "committed";
			},
		});

		expect(synced.result).toBe("committed");
		expect(synced.before.headCommit).toBe("old123");
		expect(synced.after.headCommit).toBe("new456");
		expect(synced.state).toMatchObject({
			lastCheckpointCommit: "old123",
			requiresMemoryUpdate: true,
			memoryUpdateReason: "planner_commit",
		});
	});

	it("marks conflicted mutation result as recovery state", () => {
		const synced = syncStateAfterPlannerGitMutation({
			state: baseState(),
			before: reality({ headCommit: "old123" }),
			after: reality({ headCommit: "new456", statusPorcelain: "UU a.ts" }),
			headChangeReason: "planner_merge",
		});

		expect(synced).toMatchObject({
			stage: "recovery",
			step: "inspect_git",
			stepStatus: "blocked",
			broken: true,
			requiresMemoryUpdate: true,
			memoryUpdateReason: "planner_merge",
		});
	});

	it("clears memory update gate only when checkpoint is synced to head", () => {
		const state = {
			...baseState(),
			lastCheckpointCommit: "old123",
			requiresMemoryUpdate: true,
			memoryUpdateReason: "planner_merge" as const,
		};

		expect(
			markMemoryCheckpointSynced({ state, headCommit: "new456" }),
		).toMatchObject({
			lastCheckpointCommit: "new456",
			requiresMemoryUpdate: false,
			memoryUpdateReason: null,
		});
	});
});

function baseState() {
	return createInitialPlanState({
		baseBranch: "main",
		planBranch: "plan/plan-a",
		worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
	});
}

function reality(input: Partial<PlannerGitReality> = {}): PlannerGitReality {
	return {
		repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		branch: input.branch ?? "plan/plan-a",
		headCommit: input.headCommit ?? "abc123",
		statusPorcelain: input.statusPorcelain ?? "",
		isDirty: input.isDirty ?? Boolean(input.statusPorcelain),
		hasConflicts:
			input.hasConflicts ?? input.statusPorcelain?.startsWith("UU") ?? false,
	};
}

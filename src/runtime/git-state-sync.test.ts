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
	it("inspects actual branch, head, dirty state, and conflicts", async () => {
		const git = new MockGitRunner("plan/plan-a", "abc123", "UU src/a.ts\n");

		await expect(
			inspectPlannerGitReality({
				git,
				repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			}),
		).resolves.toEqual({
			repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			branch: "plan/plan-a",
			headCommit: "abc123",
			statusPorcelain: "UU src/a.ts\n",
			isDirty: true,
			hasConflicts: true,
		});
	});

	it("allows matching branch and requires recovery for wrong branch or conflicts", () => {
		const state = { ...baseState(), currentBranch: "plan/plan-a" };

		expect(
			evaluatePlannerToolPreflight({
				state,
				reality: reality({ branch: "plan/plan-a" }),
			}),
		).toEqual({ action: "allow", reason: null });
		expect(
			evaluatePlannerToolPreflight({
				state,
				reality: reality({ branch: "task/plan-a/task-1" }),
			}),
		).toMatchObject({ action: "require_recovery" });
		expect(
			evaluatePlannerToolPreflight({
				state,
				reality: reality({ statusPorcelain: "UU a.ts" }),
			}),
		).toMatchObject({ action: "require_recovery" });
	});

	it("runs a mutation between inspections and keeps state synchronized", async () => {
		const git = new MockGitRunner("task/plan-a/task-1", "old123", "");
		const state = {
			...baseState(),
			currentBranch: "task/plan-a/task-1",
		};
		const synced = await runSyncedPlannerGitMutation({
			git,
			state,
			repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			async mutate() {
				git.setHead("new456");
				return "committed";
			},
		});

		expect(synced.result).toBe("committed");
		expect(synced.before.headCommit).toBe("old123");
		expect(synced.after.headCommit).toBe("new456");
		expect(synced.state).toMatchObject({
			currentBranch: "task/plan-a/task-1",
		});
	});

	it("marks conflicted mutation result as recovery state", () => {
		expect(
			syncStateAfterPlannerGitMutation({
				state: baseState(),
				before: reality({ headCommit: "old123" }),
				after: reality({ headCommit: "new456", statusPorcelain: "UU a.ts" }),
			}),
		).toMatchObject({
			stage: "recovery",
			step: "inspect_git",
			stepStatus: "blocked",
			broken: true,
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

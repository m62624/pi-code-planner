import { describe, expect, it } from "vitest";
import type { PlannerRuntimeState } from "../planner-state/schema";
import { checkGitPolicy, type GitPolicyInput } from "./policy";
import type { RepoState } from "./state";
import { emptyGitStatusSummary, type GitStatusSummary } from "./status-parser";

function status(changes: Partial<GitStatusSummary> = {}): GitStatusSummary {
	const next = { ...emptyGitStatusSummary(), ...changes };
	next.hasStagedChanges = next.stagedFiles.length > 0;
	next.hasUnstagedChanges = next.unstagedFiles.length > 0;
	next.hasUntrackedFiles = next.untrackedFiles.length > 0;
	next.hasConflicts = next.conflictedFiles.length > 0;
	next.isDirty =
		next.hasStagedChanges ||
		next.hasUnstagedChanges ||
		next.hasUntrackedFiles ||
		next.hasConflicts;
	return next;
}

function repo(overrides: Partial<RepoState> = {}): RepoState {
	return {
		cwd: "/repo",
		repoRoot: "/repo",
		isRepo: true,
		currentBranch: "planner/plan",
		currentCommit: "abc123",
		isDetachedHead: false,
		status: status(),
		...overrides,
	};
}

function planner(
	overrides: Partial<PlannerRuntimeState> = {},
): PlannerRuntimeState {
	return {
		version: 1,
		mode: "plan_active",
		activePlanId: "plan-1",
		activeWorkItemId: null,
		git: {
			baseBranch: "main",
			planBranch: "planner/plan",
			expectedBranch: "planner/plan",
			expectedCommit: "abc123",
			lastObservedCommit: "abc123",
		},
		pendingOperation: null,
		branches: {
			baseBranch: "main",
			planBranch: "planner/plan",
			items: {
				main: {
					name: "main",
					kind: "base",
					planId: null,
					workItemId: null,
					createdFromCommit: null,
					lastKnownCommit: "abc123",
					status: "active",
				},
				"planner/plan": {
					name: "planner/plan",
					kind: "plan",
					planId: "plan-1",
					workItemId: null,
					createdFromCommit: "abc123",
					lastKnownCommit: "abc123",
					status: "active",
				},
				"planner/plan/work/parser": {
					name: "planner/plan/work/parser",
					kind: "child",
					planId: "plan-1",
					workItemId: "work-1",
					createdFromCommit: "abc123",
					lastKnownCommit: "def456",
					status: "active",
				},
				"planner/plan/work/parser/try-a": {
					name: "planner/plan/work/parser/try-a",
					kind: "experiment",
					planId: "plan-1",
					workItemId: "work-1",
					createdFromCommit: "def456",
					lastKnownCommit: "fed987",
					status: "rejected",
				},
			},
		},
		...overrides,
	};
}

function check(overrides: Partial<GitPolicyInput>) {
	return checkGitPolicy({
		operation: "start_work_item",
		repoState: repo(),
		plannerState: planner(),
		...overrides,
	});
}

describe("checkGitPolicy start_plan", () => {
	it("requires an initialized git repo", () => {
		const result = check({
			operation: "start_plan",
			repoState: repo({
				isRepo: false,
				repoRoot: null,
				currentBranch: null,
				currentCommit: null,
			}),
		});

		expect(result).toMatchObject({
			kind: "block",
			reason: "init_required",
		});
	});

	it("blocks detached HEAD", () => {
		const result = check({
			operation: "start_plan",
			repoState: repo({ currentBranch: null, isDetachedHead: true }),
		});

		expect(result).toMatchObject({
			kind: "block",
			reason: "detached_head",
		});
	});

	it("requires a clean worktree", () => {
		const result = check({
			operation: "start_plan",
			repoState: repo({ status: status({ untrackedFiles: ["new.ts"] }) }),
		});

		expect(result).toMatchObject({
			kind: "block",
			reason: "dirty_worktree",
		});
	});

	it("allows clean repo state", () => {
		const result = check({ operation: "start_plan" });

		expect(result.kind).toBe("allow");
	});
});

describe("checkGitPolicy expected plan position", () => {
	it("blocks operations when no plan is active", () => {
		const result = check({
			plannerState: planner({ activePlanId: null }),
		});

		expect(result).toMatchObject({
			kind: "block",
			reason: "no_active_plan",
		});
	});

	it("requires an expected branch in planner state", () => {
		const result = check({
			plannerState: planner({
				git: {
					...planner().git,
					expectedBranch: null,
				},
			}),
		});

		expect(result).toMatchObject({
			kind: "block",
			reason: "missing_expected_branch",
		});
	});

	it("requires recovery when current branch moved", () => {
		const result = check({
			repoState: repo({ currentBranch: "main" }),
		});

		expect(result).toMatchObject({
			kind: "recovery_required",
			reason: "wrong_branch",
		});
	});

	it("requires recovery when current commit moved", () => {
		const result = check({
			repoState: repo({ currentCommit: "def456" }),
		});

		expect(result).toMatchObject({
			kind: "recovery_required",
			reason: "unexpected_commit",
		});
	});
});

describe("checkGitPolicy work item operations", () => {
	it("allows starting a work item from expected clean state", () => {
		const result = check({ operation: "start_work_item" });

		expect(result.kind).toBe("allow");
	});

	it("blocks starting a work item with staged files", () => {
		const result = check({
			operation: "start_work_item",
			repoState: repo({ status: status({ stagedFiles: ["a.ts"] }) }),
		});

		expect(result).toMatchObject({
			kind: "block",
			reason: "dirty_worktree",
		});
	});

	it("allows finishing a work item with changes", () => {
		const result = check({
			operation: "finish_work_item",
			repoState: repo({ status: status({ unstagedFiles: ["a.ts"] }) }),
		});

		expect(result.kind).toBe("allow");
	});

	it("blocks finishing a work item without changes", () => {
		const result = check({ operation: "finish_work_item" });

		expect(result).toMatchObject({
			kind: "block",
			reason: "no_changes",
		});
	});

	it("blocks finishing a work item with conflicts", () => {
		const result = check({
			operation: "finish_work_item",
			repoState: repo({ status: status({ conflictedFiles: ["a.ts"] }) }),
		});

		expect(result).toMatchObject({
			kind: "block",
			reason: "conflicts",
		});
	});
});

describe("checkGitPolicy branch operations", () => {
	it("requires a clean worktree before switching branches", () => {
		const result = check({
			operation: "switch_branch",
			targetBranch: "planner/other",
			repoState: repo({ status: status({ unstagedFiles: ["a.ts"] }) }),
		});

		expect(result).toMatchObject({
			kind: "block",
			reason: "dirty_worktree",
		});
	});

	it("allows switch without explicit target when mutation provides it", () => {
		const result = check({ operation: "switch_branch" });

		expect(result).toMatchObject({
			kind: "allow",
			reason: "allowed",
		});
	});

	it("requires a clean target worktree before merge", () => {
		const result = check({
			operation: "merge_branch",
			targetBranch: "planner/plan",
			repoState: repo({ status: status({ untrackedFiles: ["a.ts"] }) }),
		});

		expect(result).toMatchObject({
			kind: "block",
			reason: "dirty_worktree",
		});
	});
});

describe("checkGitPolicy delete branch", () => {
	function deleteBranch(branchName: string) {
		return check({
			operation: "delete_branch",
			branchName,
		});
	}

	it("blocks base branch deletion", () => {
		const result = deleteBranch("main");

		expect(result).toMatchObject({
			kind: "block",
			reason: "protected_branch",
		});
	});

	it("blocks plan branch deletion", () => {
		const result = deleteBranch("planner/plan");

		expect(result).toMatchObject({
			kind: "block",
			reason: "current_branch",
		});
	});

	it("blocks unknown branch deletion", () => {
		const result = deleteBranch("feature/user");

		expect(result).toMatchObject({
			kind: "block",
			reason: "unknown_branch",
		});
	});

	it("allows child branch deletion", () => {
		const result = deleteBranch("planner/plan/work/parser");

		expect(result.kind).toBe("allow");
	});

	it("allows experiment branch deletion", () => {
		const result = deleteBranch("planner/plan/work/parser/try-a");

		expect(result.kind).toBe("allow");
	});

	it("does not trust branch names without registry records", () => {
		const result = check({
			operation: "delete_branch",
			branchName: "planner/plan/work/unregistered",
		});

		expect(result).toMatchObject({
			kind: "block",
			reason: "unknown_branch",
		});
	});
});

describe("checkGitPolicy recovery operations", () => {
	it("allows recovery even when git state diverged", () => {
		const result = check({
			operation: "recover_external_change",
			repoState: repo({ currentCommit: "def456" }),
		});

		expect(result.kind).toBe("allow");
	});

	it("allows delete plan cleanup without expected position checks", () => {
		const result = check({
			operation: "delete_plan",
			repoState: repo({ currentBranch: "main", currentCommit: "def456" }),
		});

		expect(result.kind).toBe("allow");
	});
});

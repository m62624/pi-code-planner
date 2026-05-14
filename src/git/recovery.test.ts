import { describe, expect, it } from "vitest";
import type { PlannerRuntimeState } from "../planner-state/schema";
import { analyzeGitRecovery } from "./recovery";
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

function state(
	overrides: Partial<PlannerRuntimeState> = {},
): PlannerRuntimeState {
	return {
		version: 1,
		mode: "plan_active",
		activePlanId: "plan-1",
		activeWorkItemId: "work-1",
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
					lastKnownCommit: "abc123",
					status: "active",
				},
				"planner/plan/work/parser/try-a": {
					name: "planner/plan/work/parser/try-a",
					kind: "experiment",
					planId: "plan-1",
					workItemId: "work-1",
					createdFromCommit: "abc123",
					lastKnownCommit: "abc123",
					status: "active",
				},
			},
		},
		...overrides,
	};
}

describe("analyzeGitRecovery", () => {
	it("reports inactive when no plan runtime is active", () => {
		const analysis = analyzeGitRecovery(
			state({
				mode: "idle",
				activePlanId: null,
				activeWorkItemId: null,
			}),
			repo(),
		);

		expect(analysis).toMatchObject({
			status: "inactive",
			requiresRecovery: false,
		});
	});

	it("reports ok when repo matches expected planner state", () => {
		const analysis = analyzeGitRecovery(state(), repo());

		expect(analysis).toMatchObject({
			status: "ok",
			requiresRecovery: false,
		});
	});

	it("reports pending operations before other checks", () => {
		const analysis = analyzeGitRecovery(
			state({
				mode: "operation_in_progress",
				pendingOperation: {
					id: "op-1",
					type: "commit",
					startedAt: "2026-05-14T00:00:00.000Z",
					before: {
						branch: "planner/plan",
						commit: "abc123",
					},
					expectedAfter: null,
				},
			}),
			repo({ currentBranch: "unknown" }),
		);

		expect(analysis).toMatchObject({
			status: "pending_operation",
			requiresRecovery: true,
		});
	});

	it("reports missing git repo", () => {
		const analysis = analyzeGitRecovery(
			state(),
			repo({
				isRepo: false,
				repoRoot: null,
				currentBranch: null,
				currentCommit: null,
			}),
		);

		expect(analysis.status).toBe("init_required");
	});

	it("reports detached HEAD", () => {
		const analysis = analyzeGitRecovery(
			state(),
			repo({ currentBranch: null, isDetachedHead: true }),
		);

		expect(analysis.status).toBe("detached_head");
	});

	it("reports conflicts before dirty worktree", () => {
		const analysis = analyzeGitRecovery(
			state(),
			repo({ status: status({ conflictedFiles: ["src/a.ts"] }) }),
		);

		expect(analysis.status).toBe("conflicts");
	});

	it("reports registered experiment branch divergence", () => {
		const analysis = analyzeGitRecovery(
			state(),
			repo({ currentBranch: "planner/plan/work/parser/try-a" }),
		);

		expect(analysis).toMatchObject({
			status: "registered_experiment_branch",
			currentBranch: {
				kind: "experiment",
			},
		});
	});

	it("reports registered child branch divergence", () => {
		const analysis = analyzeGitRecovery(
			state(),
			repo({ currentBranch: "planner/plan/work/parser" }),
		);

		expect(analysis).toMatchObject({
			status: "registered_child_branch",
			currentBranch: {
				kind: "child",
			},
		});
	});

	it("reports unknown branch divergence", () => {
		const analysis = analyzeGitRecovery(
			state(),
			repo({ currentBranch: "feature/user" }),
		);

		expect(analysis.status).toBe("unknown_branch");
	});

	it("reports external branch change for registered non-work branch", () => {
		const analysis = analyzeGitRecovery(
			state(),
			repo({ currentBranch: "main" }),
		);

		expect(analysis).toMatchObject({
			status: "external_branch_change",
			currentBranch: {
				kind: "base",
			},
		});
	});

	it("reports external commit changes", () => {
		const analysis = analyzeGitRecovery(
			state(),
			repo({ currentCommit: "def456" }),
		);

		expect(analysis.status).toBe("external_commit_change");
	});

	it("reports dirty worktree when branch and commit still match", () => {
		const analysis = analyzeGitRecovery(
			state(),
			repo({ status: status({ unstagedFiles: ["src/a.ts"] }) }),
		);

		expect(analysis.status).toBe("dirty_worktree");
	});
});

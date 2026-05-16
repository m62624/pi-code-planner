import { describe, expect, it } from "vitest";
import { RuntimeStateManager } from "../planner-state/runtime";
import type { PlannerRuntimeState } from "../planner-state/schema";
import { savePlannerRuntimeState } from "../planner-state/store";
import { createSettingsPaths } from "../settings/paths";
import { MemoryFs } from "../test/memory-fs";
import { createGitPreflightService } from "./preflight";
import type { RepoState } from "./state";
import { emptyGitStatusSummary, type GitStatusSummary } from "./status-parser";

const paths = createSettingsPaths({
	agentDir: "/agent",
	cwd: "/repo",
	extensionName: "pi-planner",
});

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
		currentBranch: "planner/plan-1/main",
		currentCommit: "abc123",
		isDetachedHead: false,
		status: status(),
		...overrides,
	};
}

function activeState(
	overrides: Partial<PlannerRuntimeState> = {},
): PlannerRuntimeState {
	return {
		version: 1,
		mode: "plan_active",
		activePlanId: "plan-1",
		activeWorkItemId: "work-1",
		git: {
			baseBranch: "main",
			planBranch: "planner/plan-1/main",
			expectedBranch: "planner/plan-1/main",
			expectedCommit: "abc123",
			lastObservedCommit: "abc123",
		},
		pendingOperation: null,
		branches: {
			baseBranch: "main",
			planBranch: "planner/plan-1/main",
			items: {},
		},
		...overrides,
	};
}

function setup(stateValue: PlannerRuntimeState, repoState: RepoState) {
	const fs = new MemoryFs();
	savePlannerRuntimeState(paths, fs, stateValue);
	const state = new RuntimeStateManager({ paths, fs });
	state.load();
	const preflight = createGitPreflightService({
		state,
		readRepoState: async () => repoState,
	});
	return preflight;
}

describe("createGitPreflightService", () => {
	it("allows initializing git when the project is not a repo", async () => {
		const preflight = setup(
			activeState(),
			repo({
				isRepo: false,
				repoRoot: null,
				currentBranch: null,
				currentCommit: null,
			}),
		);

		const decision = await preflight.check("initialize_repo");

		expect(decision).toMatchObject({
			allowed: true,
			kind: "allow",
		});
	});

	it("blocks starting a plan from a dirty worktree", async () => {
		const preflight = setup(
			activeState({
				mode: "idle",
				activePlanId: null,
				activeWorkItemId: null,
			}),
			repo({ status: status({ unstagedFiles: ["src/a.ts"] }) }),
		);

		const decision = await preflight.check("start_plan");

		expect(decision).toMatchObject({
			allowed: false,
			kind: "block",
			policy: { reason: "dirty_worktree" },
		});
	});

	it("allows starting a work item from the clean expected branch", async () => {
		const preflight = setup(activeState(), repo());

		const decision = await preflight.check("start_work_item");

		expect(decision.allowed).toBe(true);
		expect(decision.recovery.status).toBe("ok");
	});

	it("blocks starting a work item when recovery is required", async () => {
		const preflight = setup(
			activeState(),
			repo({ currentCommit: "external456" }),
		);

		const decision = await preflight.check("start_work_item");

		expect(decision).toMatchObject({
			allowed: false,
			kind: "recovery_required",
			recovery: { status: "external_commit_change" },
		});
	});

	it("allows finishing a work item with dirty changes on expected branch", async () => {
		const preflight = setup(
			activeState(),
			repo({ status: status({ unstagedFiles: ["src/a.ts"] }) }),
		);

		const decision = await preflight.check("finish_work_item");

		expect(decision).toMatchObject({
			allowed: true,
			kind: "allow",
			recovery: { status: "dirty_worktree" },
		});
	});

	it("allows recovery only when recovery is required", async () => {
		const okPreflight = setup(activeState(), repo());
		const recoveryPreflight = setup(
			activeState(),
			repo({ currentCommit: "external456" }),
		);

		await expect(okPreflight.check("recovery")).resolves.toMatchObject({
			allowed: false,
		});
		await expect(recoveryPreflight.check("recovery")).resolves.toMatchObject({
			allowed: true,
			recovery: { status: "external_commit_change" },
		});
	});

	it("resolves target branch from state for merge_branch", async () => {
		const stateValue = activeState({
			activeWorkItemId: "work-1",
			git: {
				baseBranch: "main",
				planBranch: "planner/plan-1/main",
				expectedBranch: "planner/plan-1/work/work-1",
				expectedCommit: "abc123",
				lastObservedCommit: "abc123",
			},
			branches: {
				baseBranch: "main",
				planBranch: "planner/plan-1/main",
				items: {
					"planner/plan-1/main": {
						name: "planner/plan-1/main",
						kind: "plan",
						planId: "plan-1",
						workItemId: null,
						createdFromCommit: "abc123",
						lastKnownCommit: "abc123",
						status: "active",
					},
					"planner/plan-1/work/work-1": {
						name: "planner/plan-1/work/work-1",
						kind: "child",
						planId: "plan-1",
						workItemId: "work-1",
						createdFromCommit: "abc123",
						lastKnownCommit: "abc123",
						status: "active",
					},
				},
			},
		});
		const fs = new MemoryFs();
		savePlannerRuntimeState(paths, fs, stateValue);
		const state = new RuntimeStateManager({ paths, fs });
		state.load();
		const preflight = createGitPreflightService({
			state,
			readRepoState: async () =>
				repo({ currentBranch: "planner/plan-1/work/work-1" }),
		});

		const decision = await preflight.check("merge_branch");

		expect(decision.allowed).toBe(true);
		expect(decision.policy?.reason).toBe("allowed");
	});

	it("blocks merge_branch when no child branch is registered", async () => {
		const stateValue = activeState({
			activeWorkItemId: "work-1",
			git: {
				baseBranch: "main",
				planBranch: "planner/plan-1/main",
				expectedBranch: "planner/plan-1/main",
				expectedCommit: "abc123",
				lastObservedCommit: "abc123",
			},
			branches: {
				baseBranch: "main",
				planBranch: "planner/plan-1/main",
				items: {
					"planner/plan-1/main": {
						name: "planner/plan-1/main",
						kind: "plan",
						planId: "plan-1",
						workItemId: null,
						createdFromCommit: "abc123",
						lastKnownCommit: "abc123",
						status: "active",
					},
				},
			},
		});
		const fs = new MemoryFs();
		savePlannerRuntimeState(paths, fs, stateValue);
		const state = new RuntimeStateManager({ paths, fs });
		state.load();
		const preflight = createGitPreflightService({
			state,
			readRepoState: async () => repo(),
		});

		const decision = await preflight.check("merge_branch");

		expect(decision.allowed).toBe(false);
		expect(decision.policy?.reason).toBe("missing_target_branch");
	});
});

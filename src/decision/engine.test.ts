import { describe, expect, it } from "vitest";
import type { RepoState } from "../git/state";
import { emptyGitStatusSummary } from "../git/status-parser";
import {
	DEFAULT_PLANNER_RUNTIME_STATE,
	type PlannerRuntimeState,
} from "../planner-state/schema";
import type { PlanRecord, WorkItemRecord } from "../storage/schema";
import { decidePlannerNextAction } from "./engine";

function state(input: Partial<PlannerRuntimeState> = {}): PlannerRuntimeState {
	return {
		...DEFAULT_PLANNER_RUNTIME_STATE,
		...input,
	};
}

function repo(input: Partial<RepoState> = {}): RepoState {
	return {
		cwd: "/repo",
		repoRoot: "/repo",
		isRepo: true,
		currentBranch: "planner/plan-1/main",
		currentCommit: "commit-1",
		isDetachedHead: false,
		status: emptyGitStatusSummary(),
		...input,
	};
}

function plan(stage: PlanRecord["stage"]): PlanRecord {
	return {
		version: 1,
		projectKey: "repo",
		planId: "plan-1",
		title: "Plan",
		stage,
		status: "active",
		createdAt: "",
		updatedAt: "",
	};
}

function workItem(stage: WorkItemRecord["stage"]): WorkItemRecord {
	return {
		version: 1,
		planId: "plan-1",
		workItemId: "item-1",
		title: "Item",
		stage,
		status: "active",
		createdAt: "",
		updatedAt: "",
	};
}

function activeState(input: Partial<PlannerRuntimeState> = {}) {
	return state({
		mode: "plan_active",
		activePlanId: "plan-1",
		git: {
			...DEFAULT_PLANNER_RUNTIME_STATE.git,
			expectedBranch: "planner/plan-1/main",
			expectedCommit: "commit-1",
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
					createdFromCommit: "base",
					lastKnownCommit: "commit-1",
					status: "active",
				},
			},
		},
		...input,
	});
}

describe("decidePlannerNextAction", () => {
	it("returns idle when planner runtime is inactive", () => {
		const result = decidePlannerNextAction({
			state: state(),
			repo: repo(),
			memory: { files: {} },
		});

		expect(result).toMatchObject({
			status: "idle",
			action: "none",
			blocking: false,
		});
	});

	it("prioritizes pending compaction before normal stages", () => {
		const result = decidePlannerNextAction({
			state: activeState({
				pendingCompact: {
					id: "compact-1",
					reason: "discovery",
					status: "requested",
					requestedAt: "",
					completedAt: null,
					failedAt: null,
					error: null,
					activePlanId: "plan-1",
					activeWorkItemId: null,
					customInstructions: "",
					resumePrompt: "",
					attachToNextTurn: true,
					autoResume: true,
				},
			}),
			repo: repo(),
			memory: { files: {} },
			plan: plan("discovery_full"),
		});

		expect(result).toMatchObject({
			status: "compact_pending",
			action: "wait_for_compact_resume",
			blocking: true,
		});
	});

	it("requires recovery when git state diverges", () => {
		const result = decidePlannerNextAction({
			state: activeState(),
			repo: repo({ currentCommit: "external-commit" }),
			memory: { files: {} },
			plan: plan("plan_active"),
		});

		expect(result).toMatchObject({
			status: "recovery_required",
			action: "recover_git",
			blocking: true,
			recovery: { status: "external_commit_change" },
		});
	});

	it("blocks normal work when memory is dirty outside signature refresh", () => {
		const result = decidePlannerNextAction({
			state: activeState(),
			repo: repo(),
			memory: {
				files: {
					"src/app.ts": {
						filePath: "src/app.ts",
						reason: "git status changed",
						markedAt: "",
					},
				},
			},
			plan: plan("plan_active"),
			workItem: workItem("work_item_commit"),
		});

		expect(result).toMatchObject({
			status: "memory_refresh_required",
			action: "refresh_memory",
			blocking: true,
			dirtyFiles: ["src/app.ts"],
		});
	});

	it("allows dirty memory while implementation is still in progress", () => {
		const result = decidePlannerNextAction({
			state: activeState(),
			repo: repo(),
			memory: {
				files: {
					"src/app.ts": {
						filePath: "src/app.ts",
						reason: "git status changed",
						markedAt: "",
					},
				},
			},
			plan: plan("plan_active"),
			workItem: workItem("tdd_write_tests"),
		});

		expect(result).toMatchObject({
			status: "work_item_stage",
			action: "continue_work_item_stage",
			blocking: false,
			dirtyFiles: ["src/app.ts"],
		});
	});

	it("allows dirty worktree during implementation stages", () => {
		const dirty = emptyGitStatusSummary();
		dirty.unstagedFiles.push("src/app.ts");
		dirty.hasUnstagedChanges = true;
		dirty.isDirty = true;

		const result = decidePlannerNextAction({
			state: activeState(),
			repo: repo({ status: dirty }),
			memory: { files: {} },
			plan: plan("plan_active"),
			workItem: workItem("verification"),
		});

		expect(result).toMatchObject({
			status: "work_item_stage",
			action: "continue_work_item_stage",
			blocking: false,
			recovery: { status: "dirty_worktree" },
		});
	});

	it("allows dirty worktree during plan stages without work item", () => {
		const dirty = emptyGitStatusSummary();
		dirty.unstagedFiles.push("src/app.ts");
		dirty.hasUnstagedChanges = true;
		dirty.isDirty = true;

		const result = decidePlannerNextAction({
			state: activeState(),
			repo: repo({ status: dirty }),
			memory: { files: {} },
			plan: plan("discovery_full"),
		});

		expect(result).toMatchObject({
			status: "plan_stage",
			action: "continue_plan_stage",
			blocking: false,
			recovery: { status: "dirty_worktree" },
		});
	});

	it("allows signature refresh to clear dirty memory", () => {
		const result = decidePlannerNextAction({
			state: activeState(),
			repo: repo(),
			memory: {
				files: {
					"src/app.ts": {
						filePath: "src/app.ts",
						reason: "git status changed",
						markedAt: "",
					},
				},
			},
			plan: plan("plan_active"),
			workItem: workItem("signature_refresh"),
		});

		expect(result).toMatchObject({
			status: "work_item_stage",
			action: "continue_work_item_stage",
			blocking: false,
			workItemStage: "signature_refresh",
		});
	});

	it("requires discovery compact at the discovery boundary", () => {
		const result = decidePlannerNextAction({
			state: activeState(),
			repo: repo(),
			memory: { files: {} },
			plan: plan("discovery_compact_required"),
		});

		expect(result).toMatchObject({
			status: "compact_required",
			action: "request_discovery_compact",
			compactReason: "discovery",
			blocking: true,
		});
	});

	it("requires work item compact at the work item boundary", () => {
		const result = decidePlannerNextAction({
			state: activeState({ activeWorkItemId: "item-1" }),
			repo: repo(),
			memory: { files: {} },
			plan: plan("plan_active"),
			workItem: workItem("work_item_compact_required"),
		});

		expect(result).toMatchObject({
			status: "compact_required",
			action: "request_work_item_compact",
			compactReason: "work_item",
			blocking: true,
		});
	});
});

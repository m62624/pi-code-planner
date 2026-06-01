import { describe, expect, it } from "vitest";
import type { PlannerWrapperTool } from "../guard/tool-policy";
import type { MemoryGateInspection } from "../memory/gate";
import {
	createInitialPlanState,
	type PlanStateRecord,
} from "../storage/schema";
import type { PlannerGitReality } from "./git-state-sync";
import {
	evaluatePlannerRuntimeReality,
	type PlannerRuntimeDecision,
} from "./planner-runtime";

describe("planner runtime reality evaluator", () => {
	it("does not interfere when there is no active planner plan", () => {
		const decision = evaluatePlannerRuntimeReality({
			contextStatus: "no_active_plan",
		});

		expect(decision).toMatchObject({
			action: "no_active_plan",
			reason: "Project has no active planner plan.",
			requiresMemoryUpdate: false,
			requiresRecovery: false,
			requiresUserDecision: false,
		} satisfies Partial<PlannerRuntimeDecision>);
		expect(decision.allowedTools).toEqual([
			"planner_status",
			"planner_create_plan",
		] satisfies PlannerWrapperTool[]);
	});

	it("treats missing project storage as inactive planner flow", () => {
		expect(
			evaluatePlannerRuntimeReality({ contextStatus: "missing_project" }),
		).toMatchObject({
			action: "no_active_plan",
			reason: "Project record does not exist.",
		});
	});

	it("requires recovery when active plan records are missing", () => {
		expect(
			evaluatePlannerRuntimeReality({ contextStatus: "missing_plan" }),
		).toMatchObject({
			action: "require_recovery",
			recoveryReason: "missing_plan",
		});

		expect(
			evaluatePlannerRuntimeReality({ contextStatus: "missing_state" }),
		).toMatchObject({
			action: "require_recovery",
			recoveryReason: "missing_state",
		});
	});

	it("requires recovery when ready context has no state payload", () => {
		expect(
			evaluatePlannerRuntimeReality({ contextStatus: "ready" }),
		).toMatchObject({
			action: "require_recovery",
			recoveryReason: "missing_state",
		});
	});

	it("allows early init steps before planner worktree exists", () => {
		const decision = evaluatePlannerRuntimeReality({
			contextStatus: "ready",
			state: state({
				stage: "init",
				step: "create_plan_worktree",
				currentBranch: null,
				worktreePath: null,
				lastCheckpointCommit: null,
			}),
			worktreeExists: false,
		});

		expect(decision).toMatchObject({
			action: "allow_stage_machine",
			stage: "init",
			step: "create_plan_worktree",
			requiresRecovery: false,
		} satisfies Partial<PlannerRuntimeDecision>);
		expect(decision.allowedTools).toEqual([
			"planner_status",
			"planner_git_inspect",
		]);
	});

	it("requires recovery when active state has no usable worktree", () => {
		const decision = evaluatePlannerRuntimeReality({
			contextStatus: "ready",
			state: state({ worktreePath: null }),
			git: reality(),
		});

		expect(decision).toMatchObject({
			action: "require_recovery",
			recoveryReason: "missing_worktree",
			requiresRecovery: true,
		} satisfies Partial<PlannerRuntimeDecision>);
		expect(decision.allowedTools).toEqual([
			"planner_status",
			"planner_git_inspect",
			"planner_recovery_inspect",
			"planner_recovery_resume",
		] satisfies PlannerWrapperTool[]);
	});

	it("requires recovery when the recorded worktree was removed", () => {
		expect(
			evaluatePlannerRuntimeReality({
				contextStatus: "ready",
				state: state(),
				git: reality(),
				worktreeExists: false,
			}),
		).toMatchObject({
			action: "require_recovery",
			recoveryReason: "missing_worktree",
		});
	});

	it("prioritizes user decision over normal recovery when state asks for it", () => {
		const decision = evaluatePlannerRuntimeReality({
			contextStatus: "ready",
			state: state({ requiresUserDecision: true }),
			git: reality(),
		});

		expect(decision).toMatchObject({
			action: "require_user_decision",
			recoveryReason: "user_decision_required",
			requiresUserDecision: true,
		} satisfies Partial<PlannerRuntimeDecision>);
	});

	it("routes broken state, missing git reality, conflicts, and wrong branch into recovery", () => {
		expect(
			evaluatePlannerRuntimeReality({
				contextStatus: "ready",
				state: state({ broken: true }),
				git: reality(),
			}),
		).toMatchObject({
			action: "require_recovery",
			recoveryReason: "broken_state",
		});

		expect(
			evaluatePlannerRuntimeReality({
				contextStatus: "ready",
				state: state(),
				git: null,
			}),
		).toMatchObject({
			action: "require_recovery",
			recoveryReason: "git_unavailable",
		});

		expect(
			evaluatePlannerRuntimeReality({
				contextStatus: "ready",
				state: state(),
				git: reality({ statusPorcelain: "UU src/a.ts", hasConflicts: true }),
			}),
		).toMatchObject({
			action: "require_recovery",
			recoveryReason: "git_conflict",
		});

		expect(
			evaluatePlannerRuntimeReality({
				contextStatus: "ready",
				state: state({ currentBranch: "plan/plan-a" }),
				git: reality({ branch: "main" }),
			}),
		).toMatchObject({
			action: "require_recovery",
			recoveryReason: "wrong_branch",
		});
	});

	it("requires recovery when memory checkpoint integrity is not trusted", () => {
		expect(
			evaluatePlannerRuntimeReality({
				contextStatus: "ready",
				state: state(),
				git: reality(),
				memoryCheckpointValid: false,
			}),
		).toMatchObject({
			action: "require_recovery",
			recoveryReason: "memory_checkpoint_corrupt",
		});
	});

	it("keeps explicit memory-update gate and exposes only memory-safe wrappers", () => {
		const decision = evaluatePlannerRuntimeReality({
			contextStatus: "ready",
			state: state({
				requiresMemoryUpdate: true,
				memoryUpdateReason: "planner_merge",
			}),
			git: reality(),
		});

		expect(decision).toMatchObject({
			action: "require_memory_update",
			memoryUpdateReason: "planner_merge",
			requiresMemoryUpdate: true,
		} satisfies Partial<PlannerRuntimeDecision>);
		expect(decision.allowedTools).toEqual([
			"planner_status",
			"planner_git_inspect",
			"planner_memory_inspect",
			"planner_memory_apply_freshness",
			"planner_memory_scan_project",
			"planner_memory_index_status",
			"planner_memory_next_file",
			"planner_memory_read_chunk",
			"planner_memory_upsert_active_file",
			"planner_memory_upsert_symbols",
			"planner_memory_verify_active_file",
			"planner_memory_complete_active_file",
			"planner_memory_ignore_active_file",
			"planner_memory_upsert_relations",
			"planner_memory_search",
			"planner_memory_verify",
			"planner_memory_sync_checkpoint",
		] satisfies PlannerWrapperTool[]);
	});

	it("requires memory update when HEAD changed on the expected branch", () => {
		const decision = evaluatePlannerRuntimeReality({
			contextStatus: "ready",
			state: state({ lastCheckpointCommit: "old123" }),
			git: reality({ headCommit: "new456" }),
		});

		expect(decision).toMatchObject({
			action: "require_memory_update",
			memoryUpdateReason: "external_commit",
			reason: "HEAD new456 differs from memory checkpoint old123.",
		} satisfies Partial<PlannerRuntimeDecision>);
	});

	it("requires memory update when file hashes changed without a new HEAD", () => {
		const decision = evaluatePlannerRuntimeReality({
			contextStatus: "ready",
			state: state({ lastCheckpointCommit: "abc123" }),
			git: reality({ headCommit: "abc123", statusPorcelain: " M src/a.ts" }),
			memory: memoryGate({ clean: false }),
		});

		expect(decision).toMatchObject({
			action: "require_memory_update",
			memoryUpdateReason: "file_hash_changed",
			requiresMemoryUpdate: true,
		} satisfies Partial<PlannerRuntimeDecision>);
		expect(decision.memory?.instruction).toContain("Memory is stale");
	});

	it("allows a dirty worktree when branch, checkpoint, and memory are consistent", () => {
		expect(
			evaluatePlannerRuntimeReality({
				contextStatus: "ready",
				state: state({ lastCheckpointCommit: "abc123" }),
				git: reality({
					headCommit: "abc123",
					statusPorcelain: " M src/a.ts",
					isDirty: true,
				}),
				memory: memoryGate({ clean: true }),
			}),
		).toMatchObject({
			action: "allow_stage_machine",
			requiresRecovery: false,
			requiresMemoryUpdate: false,
		});
	});

	it("does not require memory update before the first checkpoint exists", () => {
		expect(
			evaluatePlannerRuntimeReality({
				contextStatus: "ready",
				state: state({ lastCheckpointCommit: null }),
				git: reality({ headCommit: "abc123" }),
				memory: memoryGate({ clean: true }),
			}),
		).toMatchObject({
			action: "allow_stage_machine",
			memoryUpdateReason: null,
		});
	});

	it("prioritizes stale memory over compact because compact must not preserve stale context", () => {
		expect(
			evaluatePlannerRuntimeReality({
				contextStatus: "ready",
				state: state({ requiresCompact: true }),
				git: reality(),
				memory: memoryGate({ clean: false }),
			}),
		).toMatchObject({
			action: "require_memory_update",
			memoryUpdateReason: "file_hash_changed",
			requiresCompact: false,
		});
	});

	it("blocks normal work while compact is pending", () => {
		const decision = evaluatePlannerRuntimeReality({
			contextStatus: "ready",
			state: state({ requiresCompact: true }),
			git: reality(),
			memory: memoryGate({ clean: true }),
		});

		expect(decision).toMatchObject({
			action: "require_compact",
			requiresCompact: true,
			requiresRecovery: false,
		});
		expect(decision.allowedTools).toEqual([
			"planner_status",
		] satisfies PlannerWrapperTool[]);
	});

	it("allows the stage machine only when storage, git, and memory are consistent", () => {
		const decision = evaluatePlannerRuntimeReality({
			contextStatus: "ready",
			state: state({
				stage: "execution",
				step: "write_tests",
				stepStatus: "running",
				nextStep: "run_failing_tests",
				lastCheckpointCommit: "abc123",
			}),
			git: reality({ headCommit: "abc123", statusPorcelain: "" }),
			memory: memoryGate({ clean: true }),
		});

		expect(decision).toMatchObject({
			action: "allow_stage_machine",
			reason: null,
			stage: "execution",
			step: "write_tests",
			nextStep: "run_failing_tests",
			requiresMemoryUpdate: false,
			requiresRecovery: false,
			requiresUserDecision: false,
			requiresCompact: false,
		} satisfies Partial<PlannerRuntimeDecision>);
		expect(decision.allowedTools).toEqual([
			"planner_status",
			"planner_git_inspect",
			"planner_git_commit",
			"planner_memory_search",
		] satisfies PlannerWrapperTool[]);
	});
});

function state(input: Partial<PlanStateRecord> = {}): PlanStateRecord {
	return {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		}),
		stage: "discovery",
		step: "scan_project_structure",
		stepStatus: "running",
		currentBranch: "plan/plan-a",
		lastCheckpointCommit: "abc123",
		...input,
	};
}

function reality(input: Partial<PlannerGitReality> = {}): PlannerGitReality {
	return {
		repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		branch: input.branch ?? "plan/plan-a",
		headCommit: input.headCommit ?? "abc123",
		statusPorcelain: input.statusPorcelain ?? "",
		isDirty:
			input.isDirty ??
			(input.statusPorcelain !== undefined && input.statusPorcelain !== ""),
		hasConflicts: input.hasConflicts ?? false,
	};
}

function memoryGate(input: { clean: boolean }): MemoryGateInspection {
	return {
		clean: input.clean,
		repoRoot: "/repo/app",
		snapshot: {} as MemoryGateInspection["snapshot"],
		freshness: {} as MemoryGateInspection["freshness"],
		requiredChecks: input.clean
			? []
			: ["file_index", "symbols", "relations", "effects"],
		nextAction: input.clean ? "continue" : "update_memory",
		instruction: input.clean
			? "Memory matches the current project snapshot."
			: "Memory is stale. Update memory before continuing.",
	};
}

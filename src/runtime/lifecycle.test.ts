import { describe, expect, it } from "vitest";
import type { MemoryGateInspection } from "../memory/gate";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import {
	createEmptyProjectRecord,
	createInitialPlanState,
	createPlanRecord,
	type PlanStateRecord,
} from "../storage/schema";
import { decidePlannerLifecycleNext } from "./lifecycle";
import { evaluatePlannerRuntimeReality } from "./planner-runtime";
import type { PlannerPreflightResult } from "./preflight";

describe("planner lifecycle decision", () => {
	it("returns no-active guidance without enabling workflow tools", () => {
		const preflight = unavailablePreflight("no_active_plan");

		expect(decidePlannerLifecycleNext(preflight)).toMatchObject({
			action: "no_active_plan",
			requiredTool: null,
			requiredTransition: null,
			stage: null,
			step: null,
		});
	});

	it("requires recovery inspect before normal work on wrong branch", () => {
		const preflight = readyPreflight({
			state: state({
				stage: "execution",
				step: "run_experiment",
				stepStatus: "running",
				currentBranch: "experiment/plan-a/task-1/a",
			}),
			gitBranch: "task/plan-a/task-1",
		});

		expect(decidePlannerLifecycleNext(preflight)).toMatchObject({
			action: "inspect_recovery",
			requiredTool: "planner_recovery_inspect",
			requiredTransition: null,
			runtimeAction: "require_recovery",
		});
	});

	it("keeps user-decision gates explicit", () => {
		const preflight = readyPreflight({
			state: state({ requiresUserDecision: true }),
		});

		expect(decidePlannerLifecycleNext(preflight)).toMatchObject({
			action: "ask_user_decision",
			requiredTool: "planner_recovery_inspect",
			runtimeAction: "require_user_decision",
		});
	});

	it("starts pending steps through the workflow wrapper", () => {
		const preflight = readyPreflight({
			state: state({
				stage: "planning",
				step: "draft_plan",
				stepStatus: "pending",
			}),
		});

		expect(decidePlannerLifecycleNext(preflight)).toMatchObject({
			action: "start_step",
			requiredTool: "planner_start_step",
			requiredTransition: "start_step",
		});
	});

	it("completes running non-compact steps only through complete_step", () => {
		const preflight = readyPreflight({
			state: state({
				stage: "execution",
				step: "write_tests",
				stepStatus: "running",
			}),
		});

		expect(decidePlannerLifecycleNext(preflight)).toMatchObject({
			action: "complete_step",
			requiredTool: "planner_complete_step",
			requiredTransition: "complete_step",
		});
	});

	it("requests compact while a compact step is running", () => {
		const preflight = readyPreflight({
			state: state({
				stage: "discovery",
				step: "compact_discovery",
				stepStatus: "running",
			}),
		});

		expect(decidePlannerLifecycleNext(preflight)).toMatchObject({
			action: "request_compact",
			requiredTool: "planner_request_compact",
			requiredTransition: "request_compact",
		});
	});

	it("advances completed steps without repeating them", () => {
		const preflight = readyPreflight({
			state: state({
				stage: "discovery",
				step: "read_project",
				stepStatus: "completed",
				nextStep: "write_project_patterns",
			}),
		});

		expect(decidePlannerLifecycleNext(preflight)).toMatchObject({
			action: "advance_step",
			requiredTool: "planner_advance_step",
			requiredTransition: "advance_step",
		});
	});

	it("uses compact completion only after compact gate is pending", () => {
		const preflight = readyPreflight({
			state: state({
				stage: "discovery",
				step: "compact_discovery",
				stepStatus: "blocked",
				requiresCompact: true,
			}),
		});

		expect(decidePlannerLifecycleNext(preflight)).toMatchObject({
			action: "compact_pending",
			requiredTool: "planner_complete_compact",
			requiredTransition: "complete_compact",
			runtimeAction: "require_compact",
		});
	});

	it("chooses memory write when preflight already knows stale memory details", () => {
		const preflight = readyPreflight({
			state: state({
				requiresMemoryUpdate: true,
				memoryUpdateReason: "planner_commit",
			}),
			memoryGate: memoryGate(false),
		});

		expect(decidePlannerLifecycleNext(preflight)).toMatchObject({
			action: "write_memory",
			requiredTool: "planner_memory_write_batch",
			requiredTransition: null,
			runtimeAction: "require_memory_update",
		});
	});

	it("syncs checkpoint when memory is clean and worktree is clean", () => {
		const preflight = readyPreflight({
			state: state({
				requiresMemoryUpdate: true,
				memoryUpdateReason: "planner_commit",
			}),
			memoryGate: memoryGate(true),
		});

		expect(decidePlannerLifecycleNext(preflight)).toMatchObject({
			action: "sync_memory_checkpoint",
			requiredTool: "planner_memory_sync_checkpoint",
		});
	});

	it("requires recovery inspection instead of checkpoint sync when memory boundary is dirty", () => {
		const preflight = readyPreflight({
			state: state({
				requiresMemoryUpdate: true,
				memoryUpdateReason: "planner_commit",
			}),
			memoryGate: memoryGate(true),
			gitDirty: true,
		});

		expect(decidePlannerLifecycleNext(preflight)).toMatchObject({
			action: "inspect_recovery",
			requiredTool: "planner_recovery_inspect",
		});
	});
});

function readyPreflight(input: {
	state: PlanStateRecord;
	gitBranch?: string;
	gitDirty?: boolean;
	memoryGate?: MemoryGateInspection | null;
}): PlannerPreflightResult {
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const git = {
		repoRoot: input.state.worktreePath ?? "/repo/app",
		branch: input.gitBranch ?? input.state.currentBranch ?? "plan/plan-a",
		headCommit: input.state.lastCheckpointCommit ?? "abc123",
		statusPorcelain: input.gitDirty ? " M src/a.ts" : "",
		isDirty: input.gitDirty ?? false,
		hasConflicts: false,
	};
	const decision = evaluatePlannerRuntimeReality({
		contextStatus: "ready",
		state: input.state,
		git,
		memory: input.memoryGate ?? null,
		memoryCheckpointValid: true,
		worktreeExists: true,
	});
	return {
		context: {
			status: "ready",
			projectPaths,
			planPaths,
			project: createEmptyProjectRecord({
				projectId: projectPaths.projectId,
				projectRoot: projectPaths.projectRoot,
				displayName: projectPaths.displayName,
			}),
			plan: createPlanRecord({ planId: "plan-a", title: "Plan A" }),
			state: input.state,
			activePlanId: "plan-a",
		},
		decision,
		planPaths,
		memoryPaths: null,
		gitReality: git,
		memoryGate: input.memoryGate ?? null,
		memoryCheckpoint: null,
		instructions: null,
		worktreeExists: true,
	};
}

function unavailablePreflight(
	status: "no_active_plan",
): PlannerPreflightResult {
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const context = {
		status,
		projectPaths,
		project: null,
		activePlanId: null,
		reason: status,
	} as PlannerPreflightResult["context"];
	return {
		context,
		decision: evaluatePlannerRuntimeReality({ contextStatus: status }),
		planPaths: null,
		memoryPaths: null,
		gitReality: null,
		memoryGate: null,
		memoryCheckpoint: null,
		instructions: null,
		worktreeExists: null,
	};
}

function state(input: Partial<PlanStateRecord> = {}): PlanStateRecord {
	return {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		}),
		stage: "discovery",
		step: "read_project",
		stepStatus: "pending",
		currentBranch: "plan/plan-a",
		lastCheckpointCommit: "abc123",
		...input,
	};
}

function memoryGate(clean: boolean): MemoryGateInspection {
	return {
		clean,
		repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		snapshot: {
			files: [],
			missingFiles: [],
		},
		freshness: {
			clean,
			unchangedFiles: [],
			changedFiles: clean ? [] : ["src/a.ts"],
			filesToReindex: clean ? [] : ["src/a.ts"],
			newFiles: [],
			missingFiles: [],
			affectedSymbolIds: clean ? [] : ["sym_a"],
			affectedRelationIds: [],
		},
		requiredChecks: clean
			? []
			: ["file_index", "symbols", "relations", "effects"],
		nextAction: clean ? "continue" : "update_memory",
		instruction: clean ? "Memory clean." : "Memory is stale.",
	};
}

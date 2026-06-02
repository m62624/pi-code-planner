import { describe, expect, it } from "vitest";
import { getAllowedPlannerWrapperTools } from "../guard/tool-policy";
import { getInstructionKeysForPlannerStep } from "../instructions/routing";
import { createInitialPlanState, PLANNER_STAGE_STEPS } from "../storage/schema";
import { syncStateAfterPlannerGitMutation } from "./git-state-sync";
import { PLANNER_MEMORY_TOOL_NAMES } from "./memory-tools";
import { evaluatePlannerRuntimeReality } from "./planner-runtime";
import { finishPlannerStep } from "./state-machine";

describe("simplified local-model workflow", () => {
	it("keeps discovery bounded and removes durable indexing ceremony", () => {
		expect(PLANNER_STAGE_STEPS.discovery).toEqual([
			"scan_project_structure",
			"write_questions",
			"compact_discovery",
			"enter_planning",
		]);
		expect(PLANNER_MEMORY_TOOL_NAMES).toEqual([
			"planner_memory_project_map",
			"planner_memory_search_project",
		]);
	});

	it("finishes and starts the next linear step in one transition", () => {
		expect(
			finishPlannerStep(
				state({ stage: "discovery", step: "scan_project_structure" }),
			),
		).toMatchObject({
			stage: "discovery",
			step: "write_questions",
			stepStatus: "running",
			nextStep: null,
		});
	});

	it("does not gate normal flow on stale legacy memory checkpoint fields", () => {
		const current = state({
			currentBranch: "plan/plan-a",
			lastCheckpointCommit: "old123",
			requiresMemoryUpdate: true,
			memoryUpdateReason: "planner_commit",
		});
		expect(
			evaluatePlannerRuntimeReality({
				contextStatus: "ready",
				state: current,
				worktreeExists: true,
				git: reality({ headCommit: "new456" }),
			}),
		).toMatchObject({ action: "allow_stage_machine" });
	});

	it("tracks planner git mutations without scheduling memory refresh", () => {
		const synced = syncStateAfterPlannerGitMutation({
			state: state({
				currentBranch: "plan/plan-a",
				lastCheckpointCommit: "old123",
			}),
			before: reality({ headCommit: "old123" }),
			after: reality({ headCommit: "new456" }),
			headChangeReason: "planner_commit",
		});
		expect(synced).toMatchObject({
			lastCheckpointCommit: "new456",
			requiresMemoryUpdate: false,
			memoryUpdateReason: null,
		});
	});

	it("routes only cheap context retrieval helpers", () => {
		expect(
			getAllowedPlannerWrapperTools(
				state({ stage: "discovery", step: "scan_project_structure" }),
			),
		).toEqual([
			"planner_status",
			"planner_git_inspect",
			"planner_memory_project_map",
			"planner_memory_search_project",
		]);
		expect(
			getInstructionKeysForPlannerStep({
				stage: "execution",
				step: "write_tests",
			}),
		).toEqual(["execution", "tdd"]);
	});
});

function state(overrides = {}) {
	return {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		}),
		stage: "init",
		step: "check_project",
		stepStatus: "running",
		...overrides,
	} as ReturnType<typeof createInitialPlanState>;
}

function reality(overrides = {}) {
	return {
		repoRoot: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		branch: "plan/plan-a",
		headCommit: "abc123",
		statusPorcelain: "",
		isDirty: false,
		hasConflicts: false,
		...overrides,
	};
}

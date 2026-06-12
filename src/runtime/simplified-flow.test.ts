import { describe, expect, it } from "vitest";
import { getAllowedPlannerWrapperTools } from "../guard/tool-policy";
import { getInstructionKeysForPlannerStep } from "../instructions/routing";
import { createInitialPlanState, PLANNER_STAGE_STEPS } from "../storage/schema";
import { syncStateAfterPlannerGitMutation } from "./git-state-sync";
import { evaluatePlannerRuntimeReality } from "./planner-runtime";
import { finishPlannerStep } from "./state-machine";

describe("simplified local-model workflow", () => {
	it("keeps discovery small and removes indexing ceremony", () => {
		expect(PLANNER_STAGE_STEPS.discovery).toEqual([
			"scan_project_structure",
			"write_questions",
			"compact_discovery",
			"enter_planning",
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

	it("allows normal flow when git reality matches the current branch", () => {
		const current = state({
			currentBranch: "plan/plan-a",
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

	it("tracks planner git mutations without a secondary sync phase", () => {
		const synced = syncStateAfterPlannerGitMutation({
			state: state({ currentBranch: "plan/plan-a" }),
			before: reality({ headCommit: "old123" }),
			after: reality({ headCommit: "new456" }),
		});
		expect(synced).toMatchObject({ currentBranch: "plan/plan-a" });
	});

	it("routes only cheap context retrieval helpers", () => {
		expect(
			getAllowedPlannerWrapperTools(
				state({ stage: "discovery", step: "scan_project_structure" }),
			),
		).toEqual([
			"planner_status",
			"planner_git_inspect",
			"planner_contract_scan",
			"planner_contract_route",
			"planner_contract_read",
			"planner_contract_upsert",
			"planner_git_commit",
		]);
		expect(
			getInstructionKeysForPlannerStep({
				stage: "execution",
				step: "write_tests",
			}),
		).toEqual(["execution", "tdd", "git-commit"]);
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

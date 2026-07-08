import { describe, expect, it } from "vitest";
import {
	createInitialPlanState,
	type PlannerStage,
	type PlannerStep,
	type PlanStateRecord,
} from "../storage/schema";
import { buildNextStepHint, formatAllowedNextTargets } from "./next-step-hint";

describe("buildNextStepHint", () => {
	it("states the worktree location, current step, and goal", () => {
		const hint = buildNextStepHint(
			state({ stage: "planning", step: "draft_plan", stepStatus: "running" }),
		);
		expect(hint).toContain(
			"worktree `/repo/app/.pi/pi-code-planner/worktrees/plan-a`",
		);
		expect(hint).toContain("Now: planning/draft_plan (running).");
		expect(hint).toContain("Goal: Draft an executable plan.");
		expect(hint).toContain("If unsure, re-read `planning.md`");
	});

	it("names the planner wrappers allowed at the current step", () => {
		const hint = buildNextStepHint(
			state({
				stage: "discovery",
				step: "scan_project_structure",
				stepStatus: "running",
			}),
		);
		expect(hint).toContain("Tools allowed now:");
		expect(hint).toContain("planner_discovery_submit");
	});

	it("uses the linear nextInstruction when there is a single next position", () => {
		const hint = buildNextStepHint(
			state({ stage: "planning", step: "draft_plan", stepStatus: "running" }),
		);
		expect(hint).toContain(
			"Next: Call planner_finish_step to open split_tasks.",
		);
	});

	it("lists both targets and marks the fix loop at run_final_tests", () => {
		const hint = buildNextStepHint(
			state({
				stage: "execution",
				step: "run_final_tests",
				stepStatus: "running",
			}),
		);
		expect(hint).toContain("call planner_finish_step and choose ONE target");
		expect(hint).toContain("{stage: 'execution', step: 'capture_skill'}");
		expect(hint).toContain(
			"{stage: 'execution', step: 'implement_task'} (loops back)",
		);
	});

	it("guides toward request_compact on the forced pre-doubt compact step", () => {
		const hint = buildNextStepHint(
			state({
				stage: "finalize",
				step: "compact_before_doubt",
				stepStatus: "running",
			}),
		);
		expect(hint).toContain("planner_request_compact");
	});
});

describe("formatAllowedNextTargets", () => {
	it("renders each target and tags backward moves as loops back", () => {
		const from = {
			stage: "execution" as const,
			step: "run_final_tests" as const,
		};
		const text = formatAllowedNextTargets(from, [
			{ stage: "execution", step: "capture_skill" },
			{ stage: "execution", step: "implement_task" },
		]);
		expect(text).toBe(
			"{stage: 'execution', step: 'capture_skill'} or {stage: 'execution', step: 'implement_task'} (loops back)",
		);
	});
});

function state(input: Partial<PlanStateRecord> = {}): PlanStateRecord {
	return {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		}),
		...input,
	} satisfies PlanStateRecord & {
		stage: PlannerStage;
		step: PlannerStep;
	};
}

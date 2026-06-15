import { describe, expect, it } from "vitest";
import {
	createInitialPlanState,
	type PlannerStage,
	type PlanStateRecord,
} from "../storage/schema";
import {
	checkPlannerBuiltinToolAllowed,
	type PlannerBuiltinGuardState,
} from "./project-mutation";

describe("planner built-in Pi tool guard", () => {
	it("does not interfere when no planner plan is active", () => {
		expect(
			decision({
				toolName: "write",
				path: "src/a.ts",
				state: inactiveState(),
			}),
		).toEqual({ allow: true, reason: null });
		expect(
			decision({
				toolName: "bash",
				command: "git status",
				state: inactiveState(),
			}),
		).toEqual({ allow: true, reason: null });
	});

	it("blocks project writes during init, intake, discovery, and planning", () => {
		for (const stage of ["init", "intake", "discovery", "planning"] as const) {
			expect(
				decision({
					toolName: "write",
					path: "src/a.ts",
					state: activeState(stage),
				}).allow,
				`${stage} should block project writes`,
			).toBe(false);
			expect(
				decision({
					toolName: "edit",
					path: "/repo/app/src/a.ts",
					state: activeState(stage),
				}).allow,
				`${stage} should block original checkout edits`,
			).toBe(false);
		}
	});

	it("allows planner artifact writes while project writes are blocked", () => {
		expect(
			decision({
				toolName: "write",
				path: "/agent/extensions/pi-code-planner/projects/app/plans/plan-a/discovery.md",
				state: activeState("discovery"),
			}),
		).toEqual({ allow: true, reason: null });
	});

	it("blocks direct writes to planner-managed intake files", () => {
		const state = activeState("intake");
		state.planPaths = {
			planDir: "/agent/extensions/pi-code-planner/projects/app/plans/plan-a",
			requestMd:
				"/agent/extensions/pi-code-planner/projects/app/plans/plan-a/request.md",
			goalMd:
				"/agent/extensions/pi-code-planner/projects/app/plans/plan-a/goal.md",
		};
		for (const path of [state.planPaths.goalMd, state.planPaths.requestMd]) {
			const result = decision({ toolName: "write", path, state });
			expect(result.allow, path).toBe(false);
			expect(result.reason).toContain("planner-managed file");
		}
	});

	it("blocks direct writes to questions.md and the active task tdd.md", () => {
		const planDir =
			"/agent/extensions/pi-code-planner/projects/app/plans/plan-a";
		const state = activeExecutionState("implement_task");
		state.planPaths = {
			planDir,
			requestMd: `${planDir}/request.md`,
			goalMd: `${planDir}/goal.md`,
			questionsMd: `${planDir}/questions.md`,
			tasksDir: `${planDir}/tasks`,
		};
		state.planState = { ...state.planState, activeTaskId: "parse-config" };

		const questions = decision({
			toolName: "edit",
			path: `${planDir}/questions.md`,
			state,
		});
		expect(questions.allow).toBe(false);
		expect(questions.reason).toContain("planner_questions_submit");

		const tdd = decision({
			toolName: "edit",
			path: `${planDir}/tasks/parse-config/tdd.md`,
			state,
		});
		expect(tdd.allow).toBe(false);
		expect(tdd.reason).toContain("planner_tdd_submit");
	});

	it("blocks write and edit when an active planner state cannot be loaded", () => {
		expect(
			decision({
				toolName: "write",
				path: "src/a.ts",
				state: {
					active: true,
					activePlanId: "plan-a",
					projectPaths: { projectRoot: "/repo/app" },
					planState: null,
				},
			}).allow,
		).toBe(false);
	});

	it("allows write and edit only in execution steps that permit project changes", () => {
		for (const step of [
			"write_tests",
			"implement_task",
			"refactor_task",
		] as const) {
			expect(
				decision({
					toolName: "edit",
					path: "src/a.rs",
					state: activeExecutionState(step),
				}),
				`${step} should allow project edits`,
			).toEqual({ allow: true, reason: null });
		}
	});

	it("blocks write and edit in read-only execution, finalize, done, and recovery steps", () => {
		for (const state of [
			activeExecutionState("prepare_task"),
			activeExecutionState("write_tdd_plan"),
			activeExecutionState("run_failing_tests"),
			activeExecutionState("contract_check"),
			activeState("finalize"),
			activeState("done"),
			activeState("recovery"),
		]) {
			expect(
				decision({ toolName: "edit", path: "src/a.rs", state }).allow,
			).toBe(false);
		}
	});

	it("allows external writes without classifying unrelated paths", () => {
		expect(
			decision({
				toolName: "write",
				path: "/tmp/custom-output.txt",
				state: activeState("discovery"),
			}),
		).toEqual({ allow: true, reason: null });
	});

	it("blocks original checkout edits even during an implementation step", () => {
		const result = decision({
			toolName: "edit",
			path: "/repo/app/src/a.rs",
			state: activeExecutionState("implement_task"),
		});

		expect(result.allow).toBe(false);
		expect(result.reason).toContain("original checkout");
	});

	it("allows every non-git shell command at every planner stage", () => {
		for (const stage of ALL_STAGES) {
			expect(
				decision({
					toolName: "bash",
					command: "unknown-project-alias --check && node scripts/rewrite.js",
					state: activeState(stage),
				}),
				`${stage} should allow non-git shell`,
			).toEqual({ allow: true, reason: null });
		}
	});

	it("still blocks raw git through shell while a planner plan is active", () => {
		for (const stage of ALL_STAGES) {
			const result = decision({
				toolName: "bash",
				command: "git status",
				state: activeState(stage),
			});
			expect(result.allow, `${stage} should block raw git`).toBe(false);
			expect(result.reason).toContain("Raw git is blocked");
		}
	});
});

const ALL_STAGES: readonly PlannerStage[] = [
	"init",
	"intake",
	"discovery",
	"planning",
	"execution",
	"finalize",
	"done",
	"recovery",
];

function decision(
	input:
		| {
				toolName: "write" | "edit";
				path: string;
				state: PlannerBuiltinGuardState;
		  }
		| {
				toolName: "bash";
				command: string;
				state: PlannerBuiltinGuardState;
		  },
) {
	return checkPlannerBuiltinToolAllowed({
		cwd: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		tool: input,
		state: input.state,
	});
}

function inactiveState(): PlannerBuiltinGuardState {
	return {
		active: false,
		activePlanId: null,
		projectPaths: { projectRoot: "/repo/app" },
		planState: null,
	};
}

function activeState(stage: PlannerStage): PlannerBuiltinGuardState {
	return {
		active: true,
		activePlanId: "plan-a",
		projectPaths: { projectRoot: "/repo/app" },
		planState: {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: "plan/plan-a",
				worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
			}),
			stage,
			step: stepFor(stage),
		},
	};
}

function activeExecutionState(
	step: Extract<
		PlanStateRecord["step"],
		| "prepare_task"
		| "write_tdd_plan"
		| "write_tests"
		| "run_failing_tests"
		| "implement_task"
		| "contract_check"
		| "refactor_task"
	>,
): PlannerBuiltinGuardState {
	const state = activeState("execution");
	if (!state.planState) {
		throw new Error("Expected active planner state.");
	}
	state.planState.step = step;
	return state;
}

function stepFor(stage: PlannerStage): PlanStateRecord["step"] {
	switch (stage) {
		case "init":
			return "check_project";
		case "intake":
			return "draft_goal";
		case "discovery":
			return "scan_project_structure";
		case "planning":
			return "draft_plan";
		case "execution":
			return "implement_task";
		case "finalize":
			return "verify_plan_branch";
		case "done":
			return "present_result";
		case "recovery":
			return "inspect_git";
	}
}

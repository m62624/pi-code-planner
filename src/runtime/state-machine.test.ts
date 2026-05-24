import { describe, expect, it } from "vitest";
import {
	createInitialPlanState,
	PLANNER_STAGE_STEPS,
	type PlannerStage,
	type PlannerStep,
	type PlanStateRecord,
} from "../storage/schema";
import {
	advancePlannerStep,
	blockPlannerStep,
	completePlannerCompact,
	completePlannerStep,
	enterPlannerRecovery,
	failPlannerStep,
	getAllowedNextPlannerPositions,
	getPlannerStepStage,
	isPlannerStepInStage,
	type PlannerPosition,
	PlannerStateMachineError,
	requestPlannerCompact,
	resumePlannerAfterRecovery,
	retryPlannerStep,
	startPlannerStep,
} from "./state-machine";

describe("planner state machine", () => {
	it("maps every documented step to exactly one stage", () => {
		const seen = new Set<PlannerStep>();
		for (const [stage, steps] of Object.entries(PLANNER_STAGE_STEPS) as Array<
			[PlannerStage, readonly PlannerStep[]]
		>) {
			for (const step of steps) {
				expect(seen.has(step)).toBe(false);
				seen.add(step);
				expect(getPlannerStepStage(step)).toBe(stage);
				expect(isPlannerStepInStage({ stage, step })).toBe(true);
			}
		}
	});

	it("starts only a pending step and keeps position stable", () => {
		expect(startPlannerStep(state())).toMatchObject({
			stage: "init",
			step: "check_project",
			stepStatus: "running",
			nextStep: null,
		});

		expect(() =>
			startPlannerStep(
				state({ stepStatus: "completed", nextStep: "check_git" }),
			),
		).toThrowStateMachine("step_already_completed");
	});

	it("blocks normal start while recovery, memory update, compact, or user decision gates are set", () => {
		expect(() => startPlannerStep(state({ broken: true }))).toThrowStateMachine(
			"state_blocked",
		);
		expect(() =>
			startPlannerStep(state({ requiresMemoryUpdate: true })),
		).toThrowStateMachine("state_blocked");
		expect(() =>
			startPlannerStep(state({ requiresCompact: true })),
		).toThrowStateMachine("state_blocked");
		expect(() =>
			startPlannerStep(state({ requiresUserDecision: true })),
		).toThrowStateMachine("state_blocked");
	});

	it("completes a running regular step and records the next strict step", () => {
		expect(completePlannerStep(state({ stepStatus: "running" }))).toMatchObject(
			{
				stage: "init",
				step: "check_project",
				stepStatus: "completed",
				nextStep: "check_git",
			},
		);
	});

	it("advances only from completed state to the recorded strict next step", () => {
		expect(
			advancePlannerStep(
				state({
					stepStatus: "completed",
					nextStep: "check_git",
				}),
			),
		).toMatchObject({
			stage: "init",
			step: "check_git",
			stepStatus: "pending",
			nextStep: null,
		});

		expect(() =>
			advancePlannerStep(
				state({
					stepStatus: "completed",
					nextStep: "write_symbols",
				}),
			),
		).toThrowStateMachine("invalid_next_step");
	});

	it("crosses stage boundaries only through documented enter steps", () => {
		expect(
			completePlannerStep(
				state({
					stage: "init",
					step: "enter_discovery",
					stepStatus: "running",
				}),
			),
		).toMatchObject({
			stage: "init",
			step: "enter_discovery",
			stepStatus: "completed",
			nextStep: "read_project",
		});

		expect(
			advancePlannerStep(
				state({
					stage: "init",
					step: "enter_discovery",
					stepStatus: "completed",
					nextStep: "read_project",
				}),
			),
		).toMatchObject({
			stage: "discovery",
			step: "read_project",
			stepStatus: "pending",
		});
	});

	it("requires an explicit allowed branch after select_next_task", () => {
		const current = state({
			stage: "execution",
			step: "select_next_task",
			stepStatus: "running",
		});

		expect(getAllowedNextPlannerPositions(current)).toEqual([
			{ stage: "execution", step: "prepare_task" },
			{ stage: "finalize", step: "verify_plan_branch" },
		] satisfies PlannerPosition[]);
		expect(() => completePlannerStep(current)).toThrowStateMachine(
			"ambiguous_next_step",
		);
		expect(
			completePlannerStep(current, {
				next: { stage: "finalize", step: "verify_plan_branch" },
			}),
		).toMatchObject({
			stepStatus: "completed",
			nextStep: "verify_plan_branch",
		});
		expect(() =>
			completePlannerStep(current, {
				next: { stage: "planning", step: "draft_plan" },
			}),
		).toThrowStateMachine("invalid_next_step");
	});

	it("branches done acceptance to output flow or change request flow", () => {
		const awaitUser = state({
			stage: "done",
			step: "await_user_acceptance",
			stepStatus: "running",
		});

		expect(() => completePlannerStep(awaitUser)).toThrowStateMachine(
			"ambiguous_next_step",
		);
		expect(
			completePlannerStep(awaitUser, {
				next: { stage: "done", step: "prepare_output_branch" },
			}),
		).toMatchObject({ nextStep: "prepare_output_branch" });
		expect(
			completePlannerStep(awaitUser, {
				next: { stage: "done", step: "handle_change_request" },
			}),
		).toMatchObject({ nextStep: "handle_change_request" });

		expect(
			completePlannerStep(
				state({
					stage: "done",
					step: "handle_change_request",
					stepStatus: "running",
				}),
			),
		).toMatchObject({ nextStep: "read_memory" });
	});

	it("marks failed or blocked steps and retries without moving position", () => {
		const failed = failPlannerStep(
			state({
				stage: "execution",
				step: "run_final_tests",
				stepStatus: "running",
			}),
			"tests failed",
		);
		expect(failed).toMatchObject({
			stage: "execution",
			step: "run_final_tests",
			stepStatus: "failed",
			nextStep: null,
			blockedReason: "tests failed",
		});
		expect(retryPlannerStep(failed)).toMatchObject({
			stage: "execution",
			step: "run_final_tests",
			stepStatus: "pending",
			nextStep: null,
			blockedReason: null,
		});

		expect(
			blockPlannerStep(
				state({
					stage: "planning",
					step: "verify_plan",
					stepStatus: "running",
				}),
				"needs user answer",
				{ requiresUserDecision: true },
			),
		).toMatchObject({
			stepStatus: "blocked",
			requiresUserDecision: true,
			blockedReason: "needs user answer",
		});
	});

	it("requests and completes compact only at compact steps", () => {
		expect(() =>
			requestPlannerCompact(
				state({
					stage: "discovery",
					step: "verify_memory",
					stepStatus: "running",
				}),
			),
		).toThrowStateMachine("not_compact_step");

		const pendingCompact = requestPlannerCompact(
			state({
				stage: "discovery",
				step: "compact_discovery",
				stepStatus: "running",
			}),
			"compact discovery before planning",
		);
		expect(pendingCompact).toMatchObject({
			stepStatus: "blocked",
			requiresCompact: true,
			blockedReason: "compact discovery before planning",
		});

		expect(completePlannerCompact(pendingCompact)).toMatchObject({
			stage: "discovery",
			step: "compact_discovery",
			stepStatus: "completed",
			nextStep: "enter_planning",
			requiresCompact: false,
		});
	});

	it("enters recovery from any stage and resumes only to a valid non-recovery position", () => {
		const recovery = enterPlannerRecovery(
			state({ stage: "execution", step: "run_experiment" }),
			"wrong branch",
			{ requiresUserDecision: true },
		);
		expect(recovery).toMatchObject({
			stage: "recovery",
			step: "read_state",
			stepStatus: "blocked",
			broken: true,
			requiresUserDecision: true,
			brokenReason: "wrong branch",
		});

		expect(
			resumePlannerAfterRecovery(recovery, {
				stage: "execution",
				step: "run_experiment",
			}),
		).toMatchObject({
			stage: "execution",
			step: "run_experiment",
			stepStatus: "pending",
			broken: false,
			requiresUserDecision: false,
			brokenReason: null,
		});

		expect(() =>
			resumePlannerAfterRecovery(recovery, {
				stage: "recovery",
				step: "inspect_git",
			}),
		).toThrowStateMachine("invalid_recovery_target");
	});

	it("keeps terminal completed state stable after cleanup_plan_files", () => {
		const completed = completePlannerStep(
			state({
				stage: "done",
				step: "cleanup_plan_files",
				stepStatus: "running",
			}),
		);
		expect(completed).toMatchObject({
			stepStatus: "completed",
			nextStep: null,
		});
		expect(advancePlannerStep(completed)).toBe(completed);
	});
});

expect.extend({
	toThrowStateMachine(received: () => unknown, code: string) {
		try {
			received();
		} catch (error) {
			const pass =
				error instanceof PlannerStateMachineError && error.code === code;
			return {
				pass,
				message: () =>
					pass
						? `expected not to throw PlannerStateMachineError ${code}`
						: `expected PlannerStateMachineError ${code}, got ${String(error)}`,
			};
		}
		return {
			pass: false,
			message: () => `expected PlannerStateMachineError ${code}, got no throw`,
		};
	},
});

declare module "vitest" {
	interface Assertion<T = unknown> {
		toThrowStateMachine(code: string): T;
	}
	interface AsymmetricMatchersContaining {
		toThrowStateMachine(code: string): unknown;
	}
}

function state(input: Partial<PlanStateRecord> = {}): PlanStateRecord {
	return {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath: "/repo/app/.pi/pi-code-planner/worktrees/plan-a",
		}),
		...input,
	};
}

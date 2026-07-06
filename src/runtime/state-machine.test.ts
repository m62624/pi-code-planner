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
	finishPlannerStep,
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

	it("blocks normal start while recovery, compact, or user decision gates are set", () => {
		expect(() => startPlannerStep(state({ broken: true }))).toThrowStateMachine(
			"state_blocked",
		);
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
					nextStep: "draft_plan",
				}),
			),
		).toThrowStateMachine("invalid_next_step");
	});

	it("crosses stage boundaries only through documented enter steps", () => {
		expect(
			completePlannerStep(
				state({
					stage: "init",
					step: "enter_intake",
					stepStatus: "running",
				}),
			),
		).toMatchObject({
			stage: "init",
			step: "enter_intake",
			stepStatus: "completed",
			nextStep: "draft_goal",
		});

		expect(
			advancePlannerStep(
				state({
					stage: "init",
					step: "enter_intake",
					stepStatus: "completed",
					nextStep: "draft_goal",
				}),
			),
		).toMatchObject({
			stage: "intake",
			step: "draft_goal",
			stepStatus: "pending",
		});
	});

	it("finishes a linear step atomically and starts the next step", () => {
		expect(finishPlannerStep(state({ stepStatus: "running" }))).toMatchObject({
			stage: "init",
			step: "check_git",
			stepStatus: "running",
			nextStep: null,
		});
	});

	it("requires an explicit intake approval branch before discovery", () => {
		const current = state({
			stage: "intake",
			step: "await_goal_approval",
			stepStatus: "running",
		});
		expect(getAllowedNextPlannerPositions(current)).toEqual([
			{ stage: "intake", step: "draft_goal" },
			{ stage: "discovery", step: "scan_project_structure" },
		]);
		expect(() => completePlannerStep(current)).toThrowStateMachine(
			"ambiguous_next_step",
		);
	});

	it("lets run_final_tests go back to implement_task to fix a late failure", () => {
		const current = state({
			stage: "execution",
			step: "run_final_tests",
			stepStatus: "running",
		});
		expect(getAllowedNextPlannerPositions(current)).toEqual([
			{ stage: "execution", step: "capture_skill" },
			{ stage: "execution", step: "implement_task" },
		] satisfies PlannerPosition[]);
		expect(
			completePlannerStep(current, {
				next: { stage: "execution", step: "implement_task" },
			}),
		).toMatchObject({ stepStatus: "completed", nextStep: "implement_task" });
	});

	it("names the allowed fork targets in the ambiguous_next_step error", () => {
		const current = state({
			stage: "execution",
			step: "run_final_tests",
			stepStatus: "running",
		});
		// The model calls finish_step with no target at a fork; the error must
		// spell out the valid positions so it can retry correctly, not guess again.
		expect(() => completePlannerStep(current)).toThrow(
			/multiple allowed next positions/,
		);
		expect(() => completePlannerStep(current)).toThrow(/capture_skill/);
		expect(() => completePlannerStep(current)).toThrow(/implement_task/);
	});

	it("advances compact_task linearly to select_next_task", () => {
		const current = state({
			stage: "execution",
			step: "compact_task",
			stepStatus: "running",
		});
		expect(getAllowedNextPlannerPositions(current)).toEqual([
			{ stage: "execution", step: "select_next_task" },
		] satisfies PlannerPosition[]);
		expect(
			completePlannerStep(current, {
				next: { stage: "execution", step: "select_next_task" },
			}),
		).toMatchObject({ stepStatus: "completed", nextStep: "select_next_task" });
		// Finishing into the same step must be rejected (the old deadlock symptom).
		expect(() =>
			completePlannerStep(current, {
				next: { stage: "execution", step: "compact_task" },
			}),
		).toThrowStateMachine("invalid_next_step");
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

		const changeRequest = state({
			stage: "done",
			step: "handle_change_request",
			stepStatus: "running",
		});
		// A change request amends the spec first; legacy plans (no spec.json)
		// keep the direct road to planning — the caller must pick explicitly.
		expect(getAllowedNextPlannerPositions(changeRequest)).toEqual([
			{ stage: "spec", step: "draft_requirements" },
			{ stage: "planning", step: "read_context" },
		] satisfies PlannerPosition[]);
		expect(() => completePlannerStep(changeRequest)).toThrowStateMachine(
			"ambiguous_next_step",
		);
		expect(
			completePlannerStep(changeRequest, {
				next: { stage: "planning", step: "read_context" },
			}),
		).toMatchObject({ nextStep: "read_context" });
	});

	it("branches final doubt review to summary or follow-up planning", () => {
		const doubtReview = state({
			stage: "finalize",
			step: "doubt_review",
			stepStatus: "running",
		});

		expect(() => completePlannerStep(doubtReview)).toThrowStateMachine(
			"ambiguous_next_step",
		);
		expect(
			completePlannerStep(doubtReview, {
				next: { stage: "finalize", step: "write_final_summary" },
			}),
		).toMatchObject({ nextStep: "write_final_summary" });
		expect(
			completePlannerStep(doubtReview, {
				next: { stage: "planning", step: "read_context" },
			}),
		).toMatchObject({ nextStep: "read_context" });
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

	it("allows discovery-first improve flow to return from discovery to intake", () => {
		const current = state({
			creationMethod: "improve",
			stage: "discovery",
			step: "enter_planning",
			stepStatus: "running",
		});

		expect(getAllowedNextPlannerPositions(current)).toEqual([
			{ stage: "spec", step: "draft_requirements" },
			{ stage: "intake", step: "draft_goal" },
		] satisfies PlannerPosition[]);
		expect(() => completePlannerStep(current)).toThrowStateMachine(
			"ambiguous_next_step",
		);
		expect(
			completePlannerStep(current, {
				next: { stage: "intake", step: "draft_goal" },
			}),
		).toMatchObject({
			nextStep: "draft_goal",
		});
	});

	it("keeps normal discovery enter_planning linear into the spec stage", () => {
		const current = state({
			stage: "discovery",
			step: "enter_planning",
			stepStatus: "running",
		});

		expect(getAllowedNextPlannerPositions(current)).toEqual([
			{ stage: "spec", step: "draft_requirements" },
		] satisfies PlannerPosition[]);
		expect(completePlannerStep(current)).toMatchObject({
			nextStep: "draft_requirements",
		});
	});

	it("lets verify_spec loop back to elicit_gaps or continue to compact_spec", () => {
		const current = state({
			stage: "spec",
			step: "verify_spec",
			stepStatus: "running",
		});

		expect(getAllowedNextPlannerPositions(current)).toEqual([
			{ stage: "spec", step: "compact_spec" },
			{ stage: "spec", step: "elicit_gaps" },
		] satisfies PlannerPosition[]);
		expect(() => completePlannerStep(current)).toThrowStateMachine(
			"ambiguous_next_step",
		);
		expect(
			completePlannerStep(current, {
				next: { stage: "spec", step: "elicit_gaps" },
			}),
		).toMatchObject({ nextStep: "elicit_gaps" });
	});

	it("exits the spec stage into planning via finish_spec", () => {
		const current = state({
			stage: "spec",
			step: "finish_spec",
			stepStatus: "running",
		});

		expect(getAllowedNextPlannerPositions(current)).toEqual([
			{ stage: "planning", step: "read_context" },
		] satisfies PlannerPosition[]);
		expect(completePlannerStep(current)).toMatchObject({
			nextStep: "read_context",
		});
	});

	it("requests and completes compact only at compact steps", () => {
		expect(() =>
			requestPlannerCompact(
				state({
					stage: "discovery",
					step: "write_questions",
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
		expect(requestPlannerCompact(pendingCompact, "retry compact")).toBe(
			pendingCompact,
		);

		expect(completePlannerCompact(pendingCompact)).toMatchObject({
			stage: "discovery",
			step: "enter_planning",
			stepStatus: "running",
			nextStep: null,
			requiresCompact: false,
			// The next planner_status re-inlines the full stage instruction once.
			pendingFullStatus: true,
		});
	});

	it("enters recovery from any stage and resumes only to a valid non-recovery position", () => {
		const recovery = enterPlannerRecovery(
			state({ stage: "execution", step: "implement_task" }),
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
				step: "implement_task",
			}),
		).toMatchObject({
			stage: "execution",
			step: "implement_task",
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

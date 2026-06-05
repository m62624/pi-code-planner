import { describe, expect, it } from "vitest";
import { createInitialPlanState } from "../storage/schema";
import {
	evaluatePlannerIdleWake,
	markPlannerIdleWakeQueued,
	markPlannerToolActivity,
} from "./idle-watchdog";

const settings = {
	enabled: true,
	timeoutMinutes: 10,
};

describe("planner idle watchdog", () => {
	it("initializes missing activity without waking immediately", () => {
		const state = {
			...createInitialPlanState({
				baseBranch: "main",
				planBranch: "plan/plan-a",
				worktreePath: "/repo/app/.pi/worktrees/plan-a",
			}),
			stage: "execution" as const,
			step: "implement_task" as const,
			stepStatus: "running" as const,
			activeTaskId: "task-1",
		};

		expect(
			evaluatePlannerIdleWake({ state, settings, now: 1_000 }),
		).toMatchObject({
			action: "initialize",
			timestamp: 1_000,
		});
	});

	it("wakes once after the configured timeout on execution steps", () => {
		const state = markPlannerToolActivity(
			{
				...createInitialPlanState({
					baseBranch: "main",
					planBranch: "plan/plan-a",
					worktreePath: "/repo/app/.pi/worktrees/plan-a",
				}),
				stage: "execution" as const,
				step: "implement_task" as const,
				stepStatus: "running" as const,
				activeTaskId: "task-1",
			},
			1_000,
		);

		const wake = evaluatePlannerIdleWake({
			state,
			settings,
			now: 601_000,
		});
		expect(wake.action).toBe("wake");
		expect(wake).toMatchObject({ timestamp: 601_000 });
		expect(wake.action === "wake" ? wake.message : "").toContain(
			"[SYSTEM_INSTRUCTIONS]",
		);
		expect(wake.action === "wake" ? wake.message : "").toContain(
			"planner_report_stuck",
		);

		const queued = markPlannerIdleWakeQueued(state, 601_000);
		expect(
			evaluatePlannerIdleWake({ state: queued, settings, now: 900_000 }),
		).toMatchObject({
			action: "wait",
			reason: "Planner idle wake was already queued for this idle window.",
		});
	});

	it("does not wake while waiting for user answers or acceptance", () => {
		const base = markPlannerToolActivity(
			{
				...createInitialPlanState({
					baseBranch: "main",
					planBranch: "plan/plan-a",
					worktreePath: "/repo/app/.pi/worktrees/plan-a",
				}),
				stage: "discovery" as const,
				step: "write_questions" as const,
				stepStatus: "running" as const,
				questionsSubmitted: true,
				questionsResolved: false,
			},
			1_000,
		);

		expect(
			evaluatePlannerIdleWake({ state: base, settings, now: 900_000 }),
		).toMatchObject({
			action: "disabled",
			reason: "Discovery questions were submitted and need user answers.",
		});
		expect(
			evaluatePlannerIdleWake({
				state: {
					...base,
					stage: "done",
					step: "await_user_acceptance",
				},
				settings,
				now: 900_000,
			}),
		).toMatchObject({ action: "disabled" });
	});
});

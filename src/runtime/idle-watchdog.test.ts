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

	// A compact boundary that never completed: requiresCompact is pending and the
	// step is blocked (not running), which the normal gate would silence forever.
	const stuckCompact = () =>
		markPlannerToolActivity(
			{
				...createInitialPlanState({
					baseBranch: "main",
					planBranch: "plan/plan-a",
					worktreePath: "/repo/app/.pi/worktrees/plan-a",
				}),
				stage: "execution" as const,
				step: "compact_task" as const,
				stepStatus: "blocked" as const,
				requiresCompact: true,
			},
			1_000,
		);

	it("rescues a stuck compact boundary when no compaction is in flight", () => {
		const wake = evaluatePlannerIdleWake({
			state: stuckCompact(),
			settings,
			now: 601_000,
			compactionInFlight: false,
		});
		expect(wake.action).toBe("wake");
		const message = wake.action === "wake" ? wake.message : "";
		expect(message).toContain("[SYSTEM_INSTRUCTIONS]");
		expect(message).toContain("compact boundary is stuck");
		expect(message).toContain("planner_complete_compact");
		expect(message).not.toContain("planner_report_stuck");
	});

	it("stays silent while a compaction is actually in flight", () => {
		expect(
			evaluatePlannerIdleWake({
				state: stuckCompact(),
				settings,
				now: 601_000,
				compactionInFlight: true,
			}),
		).toMatchObject({ action: "disabled" });
	});

	it("does not rescue a broken state even with a pending compact", () => {
		expect(
			evaluatePlannerIdleWake({
				state: { ...stuckCompact(), broken: true },
				settings,
				now: 601_000,
				compactionInFlight: false,
			}),
		).toMatchObject({ action: "disabled" });
	});

	it("waits for the timeout before rescuing a stuck compact", () => {
		expect(
			evaluatePlannerIdleWake({
				state: stuckCompact(),
				settings,
				now: 60_000,
				compactionInFlight: false,
			}),
		).toMatchObject({ action: "wait" });
	});
});

import { describe, expect, it } from "vitest";
import type { PlannerTimerSettings } from "../settings/schema";
import {
	createInitialPlanState,
	type PlannerStage,
	type PlanStateRecord,
} from "../storage/schema";
import { reconcilePlannerTimer } from "./timer";

const settings: PlannerTimerSettings = {
	enabled: true,
	mode: "status",
	showCheckpoints: true,
	maxCheckpoints: 5,
	syncIntervalMinutes: 10,
};

describe("planner timer", () => {
	it("initializes active timer without writing elapsed time immediately", () => {
		const result = reconcilePlannerTimer({
			state: state(),
			planStatus: "active",
			settings,
			now: 1_000,
		});

		expect(result.changed).toBe(true);
		expect(result.status).toBe("active");
		expect(result.displayActiveMs).toBe(0);
		expect(result.state.timer).toMatchObject({
			startedAt: 1_000,
			lastSyncedAt: 1_000,
			activeMs: 0,
			pausedAt: null,
			finishedAt: null,
			stage: "execution",
		});
	});

	it("caps a resumed offline gap to one sync interval", () => {
		const initial = reconcilePlannerTimer({
			state: state(),
			planStatus: "active",
			settings,
			now: 0,
		}).state;

		const result = reconcilePlannerTimer({
			state: initial,
			planStatus: "active",
			settings,
			now: 60 * 60 * 1000,
		});

		expect(result.changed).toBe(true);
		expect(result.state.timer?.activeMs).toBe(10 * 60 * 1000);
		expect(result.displayActiveMs).toBe(10 * 60 * 1000);
	});

	it("pauses at user approval gates and does not count paused time", () => {
		const running = reconcilePlannerTimer({
			state: state(),
			planStatus: "active",
			settings,
			now: 0,
		}).state;
		const paused = reconcilePlannerTimer({
			state: state({
				...running,
				stage: "intake",
				step: "await_goal_approval",
			}),
			planStatus: "active",
			settings,
			now: 5 * 60 * 1000,
		}).state;

		const stillPaused = reconcilePlannerTimer({
			state: paused,
			planStatus: "active",
			settings,
			now: 30 * 60 * 1000,
		});

		expect(stillPaused.status).toBe("paused");
		expect(stillPaused.state.timer?.activeMs).toBe(5 * 60 * 1000);
		expect(stillPaused.displayActiveMs).toBe(5 * 60 * 1000);
	});

	it("counts active intake drafting and compaction (honest timing)", () => {
		for (const position of [
			{ stage: "intake" as const, step: "draft_goal" as const },
			{ stage: "discovery" as const, step: "compact_discovery" as const },
		]) {
			const initialized = reconcilePlannerTimer({
				state: { ...state(position), requiresCompact: true },
				planStatus: "active",
				settings,
				now: 0,
			}).state;

			const later = reconcilePlannerTimer({
				state: initialized,
				planStatus: "active",
				settings,
				now: 5 * 60 * 1000,
			});

			expect(later.status).toBe("active");
			expect(later.displayActiveMs).toBeGreaterThan(0);
		}
	});

	it("resumes from pause without counting the paused gap", () => {
		const paused = reconcilePlannerTimer({
			state: state({
				stage: "intake",
				step: "await_goal_approval",
			}),
			planStatus: "active",
			settings,
			now: 0,
		}).state;

		const resumed = reconcilePlannerTimer({
			state: state({
				...paused,
				stage: "discovery",
				step: "scan_project_structure",
			}),
			planStatus: "active",
			settings,
			now: 60 * 60 * 1000,
		});

		expect(resumed.status).toBe("active");
		expect(resumed.state.timer?.pausedAt).toBe(null);
		expect(resumed.state.timer?.activeMs).toBe(0);
		expect(resumed.displayActiveMs).toBe(0);
	});

	it("records a checkpoint on stage change", () => {
		const running = reconcilePlannerTimer({
			state: state(),
			planStatus: "active",
			settings,
			now: 0,
		}).state;

		const next = reconcilePlannerTimer({
			state: state({
				...running,
				stage: "finalize",
				step: "verify_plan_branch",
			}),
			planStatus: "active",
			settings,
			now: 2 * 60 * 1000,
		});

		expect(next.changed).toBe(true);
		expect(next.state.timer?.checkpoints.map((item) => item.stage)).toEqual([
			"execution",
			"finalize",
		]);
		expect(next.state.timer?.checkpoints.at(-1)?.activeMs).toBe(2 * 60 * 1000);
	});
});

function state(input: Partial<PlanStateRecord> = {}): PlanStateRecord {
	return {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/demo",
			worktreePath: "/repo/.pi/pi-code-planner/worktrees/demo",
		}),
		stage: "execution" as PlannerStage,
		step: "implement_task",
		stepStatus: "running",
		...input,
	};
}

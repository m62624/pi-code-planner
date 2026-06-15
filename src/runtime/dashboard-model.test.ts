import { describe, expect, it } from "vitest";
import {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "../storage/paths";
import {
	createEmptyProjectRecord,
	createInitialPlanState,
	createPlanRecord,
	type PlannerTimerState,
	type PlanStateRecord,
	type PlanTaskSummary,
} from "../storage/schema";
import type {
	ActivePlanContextReady,
	ActivePlanContextUnavailable,
} from "./active-plan";
import {
	buildPlannerDashboardModel,
	composeDashboard,
	DASHBOARD_STAGE_SEQUENCE,
	type DashboardModel,
	type DashboardPalette,
	type DashboardUiState,
	renderStageRibbon,
	renderTicker,
} from "./dashboard-model";

const identityPalette: DashboardPalette = {
	text: (s) => s,
	accent: (s) => s,
	muted: (s) => s,
	dim: (s) => s,
	success: (s) => s,
	warning: (s) => s,
	error: (s) => s,
	border: (s) => s,
	bold: (s) => s,
	inverse: (s) => s,
	stage: (_stage, s) => s,
	measure: (s) => s.length,
	clip: (s, width) => (s.length <= width ? s : s.slice(0, Math.max(0, width))),
};

const defaultUi: DashboardUiState = {
	selectedIndex: 0,
	taskScroll: 0,
	tickerOffset: 0,
	focus: "tasks",
};

function readyContext(
	overrides: Partial<PlanStateRecord> = {},
	options: {
		tasks?: PlanTaskSummary[];
		title?: string;
		timer?: PlannerTimerState;
	} = {},
): ActivePlanContextReady {
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	const planPaths = createPlanStoragePaths(projectPaths, "plan-a");
	const state: PlanStateRecord = {
		...createInitialPlanState({
			baseBranch: "main",
			planBranch: "plan/plan-a",
			worktreePath: "/repo/app/.pi/worktrees/plan-a",
		}),
		...overrides,
	};
	if (options.timer) state.timer = options.timer;
	return {
		status: "ready",
		projectPaths,
		planPaths,
		project: {
			...createEmptyProjectRecord({
				projectId: projectPaths.projectId,
				projectRoot: "/repo/app",
				displayName: "app",
			}),
			activePlanId: "plan-a",
		},
		plan: {
			...createPlanRecord({
				planId: "plan-a",
				title: options.title ?? "Plan A",
			}),
			status: "active",
			tasks: options.tasks ?? [],
		},
		state,
		activePlanId: "plan-a",
	};
}

function unavailableContext(
	status: ActivePlanContextUnavailable["status"],
): ActivePlanContextUnavailable {
	const projectPaths = createProjectStoragePaths({
		agentDir: "/agent",
		projectRoot: "/repo/app",
	});
	return {
		status,
		projectPaths,
		project: null,
		activePlanId: null,
		reason: "unavailable",
	};
}

function timerWith(
	checkpoints: PlannerTimerState["checkpoints"],
	activeMs: number,
): PlannerTimerState {
	return {
		startedAt: 0,
		lastSyncedAt: activeMs,
		activeMs,
		pausedAt: null,
		finishedAt: null,
		stage: checkpoints[checkpoints.length - 1]?.stage ?? "init",
		stageStartedAt: 0,
		checkpoints,
	};
}

describe("buildPlannerDashboardModel", () => {
	it("reports unavailable when no plan is active", () => {
		const model = buildPlannerDashboardModel({
			context: unavailableContext("no_active_plan"),
			now: 1000,
		});
		expect(model.available).toBe(false);
		if (!model.available) {
			expect(model.hint).toContain("/planner-create");
		}
	});

	it("derives stage position, progress, and task counts", () => {
		const tasks: PlanTaskSummary[] = [
			{ taskId: "task-1", title: "Schema", status: "done" },
			{ taskId: "task-2", title: "Runner", status: "done" },
			{ taskId: "task-3", title: "Codec", status: "active" },
			{ taskId: "task-4", title: "Policy", status: "pending" },
		];
		const model = buildPlannerDashboardModel({
			context: readyContext(
				{
					stage: "execution",
					step: "implement_task",
					stepStatus: "running",
					activeTaskId: "task-3",
					currentBranch: "task/plan-a/task-3",
				},
				{ tasks },
			),
			now: 5000,
		}) as DashboardModel;

		expect(model.available).toBe(true);
		expect(model.stage).toBe("execution");
		expect(model.stageIndex).toBe(
			DASHBOARD_STAGE_SEQUENCE.indexOf("execution"),
		);
		expect(model.stepCount).toBeGreaterThan(0);
		expect(model.tasksDone).toBe(2);
		expect(model.tasksTotal).toBe(4);
		expect(model.overallRatio).toBeGreaterThan(0);
		expect(model.overallRatio).toBeLessThan(1);
		expect(model.statusLabel).toBe("run");
	});

	it("aggregates per-stage timings from timer checkpoints", () => {
		const timer = timerWith(
			[
				{ stage: "discovery", enteredAt: 0, activeMs: 0 },
				{ stage: "planning", enteredAt: 0, activeMs: 60_000 },
				{ stage: "execution", enteredAt: 0, activeMs: 150_000 },
			],
			200_000,
		);
		const model = buildPlannerDashboardModel({
			context: readyContext(
				{ stage: "execution", step: "implement_task" },
				{ timer },
			),
			now: 200_000,
		}) as DashboardModel;

		const byStage = Object.fromEntries(
			model.timings.map((t) => [t.stage, t.activeMs]),
		);
		expect(byStage.discovery).toBe(60_000);
		expect(byStage.planning).toBe(90_000);
		expect(byStage.execution).toBe(50_000);
		expect(model.routeTrail).toEqual(["discovery", "planning", "execution"]);
	});

	it("flags stuck and recovery states", () => {
		const stuck = buildPlannerDashboardModel({
			context: readyContext({
				stage: "execution",
				step: "implement_task",
				lastStuckAttemptId: "attempt-001",
			}),
			now: 1000,
		}) as DashboardModel;
		expect(stuck.stuck).toBe(true);
		expect(stuck.statusLabel).toBe("stuck");

		const recovery = buildPlannerDashboardModel({
			context: readyContext({ stage: "recovery", step: "read_state" }),
			now: 1000,
		}) as DashboardModel;
		expect(recovery.recovery).toBe(true);
		expect(recovery.statusLabel).toBe("recovery");
	});
});

describe("renderStageRibbon", () => {
	it("fills the exact width and embeds stage labels", () => {
		const model = buildPlannerDashboardModel({
			context: readyContext({ stage: "execution", step: "implement_task" }),
			now: 1000,
		}) as DashboardModel;
		const [line] = renderStageRibbon(model, 70, identityPalette);
		expect(line.length).toBe(70);
		expect(line).toContain("INIT");
		expect(line).toContain("DONE");
	});
});

describe("renderTicker", () => {
	it("returns a window of the exact width when content overflows", () => {
		const model = buildPlannerDashboardModel({
			context: readyContext({
				stage: "execution",
				step: "implement_task",
				activeTaskId: "task-3",
				currentBranch: "task/plan-a/task-3",
			}),
			now: 1000,
		}) as DashboardModel;
		const a = renderTicker(model, 30, 0, identityPalette);
		const b = renderTicker(model, 30, 5, identityPalette);
		expect(a.length).toBe(30);
		expect(b.length).toBe(30);
		expect(a).not.toBe(b);
	});
});

describe("composeDashboard", () => {
	const tasks: PlanTaskSummary[] = Array.from({ length: 12 }, (_, i) => ({
		taskId: `task-${i + 1}`,
		title: `Task number ${i + 1}`,
		status: i < 3 ? "done" : i === 3 ? "active" : "pending",
	}));

	it("produces exactly height lines bounded to width (full layout)", () => {
		const model = buildPlannerDashboardModel({
			context: readyContext(
				{ stage: "execution", step: "implement_task", activeTaskId: "task-4" },
				{ tasks, title: "Codec round-trip" },
			),
			now: 90_000,
		});
		const lines = composeDashboard({
			model,
			width: 100,
			height: 28,
			palette: identityPalette,
			ui: defaultUi,
		});
		expect(lines).toHaveLength(28);
		for (const line of lines) {
			expect(line.length).toBe(100);
		}
	});

	it("produces a bounded compact layout on narrow terminals", () => {
		const model = buildPlannerDashboardModel({
			context: readyContext(
				{ stage: "discovery", step: "write_questions" },
				{ tasks },
			),
			now: 30_000,
		});
		const lines = composeDashboard({
			model,
			width: 48,
			height: 14,
			palette: identityPalette,
			ui: defaultUi,
		});
		expect(lines).toHaveLength(14);
		for (const line of lines) {
			expect(line.length).toBe(48);
		}
	});

	it("renders an unavailable frame when no plan is active", () => {
		const model = buildPlannerDashboardModel({
			context: unavailableContext("no_active_plan"),
			now: 1000,
		});
		const lines = composeDashboard({
			model,
			width: 60,
			height: 12,
			palette: identityPalette,
			ui: defaultUi,
		});
		expect(lines).toHaveLength(12);
		expect(lines.join("\n")).toContain("/planner-create");
	});
});

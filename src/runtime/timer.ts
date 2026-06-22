import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { MS_PER_MINUTE } from "../constants";
import { isPlanActive } from "../index.tool-visibility";
import { loadEffectivePlannerSettings } from "../settings/manager";
import type { PlannerTimerSettings } from "../settings/schema";
import { createNodeFs, type PlannerFs } from "../storage/fs";
import { resolveProjectStoragePaths } from "../storage/project-resolver";
import type {
	PlannerTimerState,
	PlanStateRecord,
	PlanStatus,
} from "../storage/schema";
import { updatePlanState } from "../storage/state-store";
import { readActivePlanContext } from "./active-plan";
import { formatDuration } from "./time-format";

export interface PlannerTimerRuntimeState {
	latestContext: ExtensionContext | null;
	checking: boolean;
	timer: ReturnType<typeof setInterval> | null;
}

export interface PlannerTimerReconcileResult {
	state: PlanStateRecord;
	changed: boolean;
	displayActiveMs: number;
	status: "active" | "paused" | "finished";
}

const TIMER_STATUS_KEY = "pi-code-planner-timer";
const TIMER_WIDGET_KEY = "pi-code-planner-timer";
const TIMER_POLL_MS = 1_000;

export function createPlannerTimerRuntimeState(): PlannerTimerRuntimeState {
	return {
		latestContext: null,
		checking: false,
		timer: null,
	};
}

export function registerPlannerRuntimeTimer(
	pi: ExtensionAPI,
	runtime: PlannerTimerRuntimeState,
): void {
	const capture = (_event: unknown, ctx: ExtensionContext) => {
		runtime.latestContext = ctx;
		void runPlannerTimerTick(runtime);
	};

	pi.on("session_start", capture);
	pi.on("turn_start", capture);
	pi.on("turn_end", capture);
	pi.on("tool_call", capture);

	if (!runtime.timer) {
		runtime.timer = setInterval(() => {
			void runPlannerTimerTick(runtime);
		}, TIMER_POLL_MS);
		runtime.timer.unref?.();
	}

	pi.on("session_shutdown", async () => {
		if (runtime.timer) {
			clearInterval(runtime.timer);
			runtime.timer = null;
		}
	});
}

export async function runPlannerTimerTick(
	runtime: PlannerTimerRuntimeState,
): Promise<void> {
	const ctx = runtime.latestContext;
	if (!ctx || runtime.checking) return;

	runtime.checking = true;
	try {
		if (!ctx.hasUI || !isPlanActive()) {
			clearPlannerTimerUi(ctx);
			return;
		}

		const fs = createNodeFs();
		const projectPaths = await resolveProjectStoragePaths({
			fs,
			agentDir: getAgentDir(),
			cwd: ctx.cwd,
		});
		const settings = await loadEffectivePlannerSettings({ fs, projectPaths });
		if (!settings.effective.timer.enabled) {
			clearPlannerTimerUi(ctx);
			return;
		}

		const context = await readActivePlanContext({ fs, projectPaths });
		if (context.status !== "ready") {
			clearPlannerTimerUi(ctx);
			return;
		}

		const now = Date.now();
		const result = reconcilePlannerTimer({
			state: context.state,
			planStatus: context.plan.status,
			settings: settings.effective.timer,
			now,
		});
		if (result.changed) {
			await persistPlannerTimerState({
				fs,
				planPaths: context.planPaths,
				timer: result.state.timer,
			});
		}

		renderPlannerTimerUi({
			ctx,
			state: result.state,
			displayActiveMs: result.displayActiveMs,
			status: result.status,
			settings: settings.effective.timer,
			now,
		});
	} catch {
		// Timer UI is best-effort and must never block planner workflow.
	} finally {
		runtime.checking = false;
	}
}

export function reconcilePlannerTimer(input: {
	state: PlanStateRecord;
	planStatus: PlanStatus;
	settings: PlannerTimerSettings;
	now: number;
}): PlannerTimerReconcileResult {
	const syncMs = syncIntervalMs(input.settings);
	let changed = false;
	let timer =
		input.state.timer ??
		createPlannerTimerState({
			state: input.state,
			now: input.now,
			paused: shouldPausePlannerTimer(input.state, input.planStatus),
			finished: shouldFinishPlannerTimer(input.state, input.planStatus),
		});
	if (!input.state.timer) changed = true;

	if (timer.stage !== input.state.stage) {
		timer = addElapsedIfRunning(timer, input.now, syncMs);
		timer = {
			...timer,
			stage: input.state.stage,
			stageStartedAt: input.now,
			checkpoints: [
				...timer.checkpoints,
				{
					stage: input.state.stage,
					enteredAt: input.now,
					activeMs: timer.activeMs,
				},
			],
		};
		changed = true;
	}

	if (shouldFinishPlannerTimer(input.state, input.planStatus)) {
		if (timer.finishedAt === null) {
			timer = {
				...addElapsedIfRunning(timer, input.now, syncMs),
				pausedAt: null,
				finishedAt: input.now,
				lastSyncedAt: input.now,
			};
			changed = true;
		}
	} else if (shouldPausePlannerTimer(input.state, input.planStatus)) {
		if (timer.pausedAt === null && timer.finishedAt === null) {
			timer = {
				...addElapsedIfRunning(timer, input.now, syncMs),
				pausedAt: input.now,
				lastSyncedAt: input.now,
			};
			changed = true;
		}
	} else if (timer.pausedAt !== null || timer.finishedAt !== null) {
		timer = {
			...timer,
			pausedAt: null,
			finishedAt: null,
			lastSyncedAt: input.now,
		};
		changed = true;
	} else if (input.now - timer.lastSyncedAt >= syncMs) {
		timer = addElapsedIfRunning(timer, input.now, syncMs);
		changed = true;
	}

	const state = { ...input.state, timer };
	const status = timer.finishedAt
		? "finished"
		: timer.pausedAt !== null
			? "paused"
			: "active";
	return {
		state,
		changed,
		displayActiveMs: displayActiveMs(timer, input.now, syncMs),
		status,
	};
}

function createPlannerTimerState(input: {
	state: PlanStateRecord;
	now: number;
	paused: boolean;
	finished: boolean;
}): PlannerTimerState {
	return {
		startedAt: input.now,
		lastSyncedAt: input.now,
		activeMs: 0,
		pausedAt: input.paused && !input.finished ? input.now : null,
		finishedAt: input.finished ? input.now : null,
		stage: input.state.stage,
		stageStartedAt: input.now,
		checkpoints: [
			{
				stage: input.state.stage,
				enteredAt: input.now,
				activeMs: 0,
			},
		],
	};
}

function addElapsedIfRunning(
	timer: PlannerTimerState,
	now: number,
	syncMs: number,
): PlannerTimerState {
	if (timer.pausedAt !== null || timer.finishedAt !== null) return timer;
	const elapsed = Math.max(0, Math.min(now - timer.lastSyncedAt, syncMs));
	if (elapsed === 0 && timer.lastSyncedAt === now) return timer;
	return {
		...timer,
		activeMs: timer.activeMs + elapsed,
		lastSyncedAt: now,
	};
}

function displayActiveMs(
	timer: PlannerTimerState,
	now: number,
	syncMs: number,
): number {
	if (timer.pausedAt !== null || timer.finishedAt !== null)
		return timer.activeMs;
	return (
		timer.activeMs + Math.max(0, Math.min(now - timer.lastSyncedAt, syncMs))
	);
}

function shouldFinishPlannerTimer(
	state: PlanStateRecord,
	planStatus: PlanStatus,
): boolean {
	return (
		planStatus === "done" ||
		(state.stage === "done" &&
			state.step === "cleanup_plan_files" &&
			state.stepStatus === "completed")
	);
}

function shouldPausePlannerTimer(
	state: PlanStateRecord,
	planStatus: PlanStatus,
): boolean {
	if (shouldFinishPlannerTimer(state, planStatus)) return false;
	// Pause only while genuinely waiting on the user. Active work — including
	// planner-controlled compaction — keeps counting for honest timing.
	if (state.requiresUserDecision) return true;
	if (state.stage === "intake" && state.step === "await_goal_approval") {
		return true;
	}
	if (
		state.stage === "discovery" &&
		state.step === "write_questions" &&
		state.questionsSubmitted &&
		!state.questionsResolved
	) {
		return true;
	}
	if (
		state.stage === "done" &&
		(state.step === "present_result" || state.step === "await_user_acceptance")
	) {
		return true;
	}
	return false;
}

async function persistPlannerTimerState(input: {
	fs: PlannerFs;
	planPaths: Parameters<typeof updatePlanState>[1];
	timer: PlannerTimerState | null;
}): Promise<void> {
	await updatePlanState(input.fs, input.planPaths, (state) => ({
		...state,
		timer: input.timer,
	}));
}

function renderPlannerTimerUi(input: {
	ctx: ExtensionContext;
	state: PlanStateRecord;
	displayActiveMs: number;
	status: "active" | "paused" | "finished";
	settings: PlannerTimerSettings;
	now: number;
}): void {
	if (input.settings.mode === "widget") {
		setPlannerStatus(input.ctx, undefined);
		setPlannerWidget(input.ctx, buildTimerWidgetLines(input));
		return;
	}

	setPlannerWidget(input.ctx, undefined);
	setPlannerStatus(input.ctx, buildTimerStatusLine(input));
}

function clearPlannerTimerUi(ctx: ExtensionContext): void {
	setPlannerStatus(ctx, undefined);
	setPlannerWidget(ctx, undefined);
}

function buildTimerStatusLine(input: {
	ctx: ExtensionContext;
	state: PlanStateRecord;
	displayActiveMs: number;
	status: "active" | "paused" | "finished";
	settings: PlannerTimerSettings;
}): string {
	const theme = input.ctx.ui.theme;
	const stateLabel =
		input.status === "active"
			? theme.fg("accent", "run")
			: input.status === "paused"
				? theme.fg("warning", "wait")
				: theme.fg("success", "done");
	const parts = [
		theme.fg("dim", "Planner"),
		stateLabel,
		"total",
		formatClock(input.displayActiveMs),
		input.status === "paused"
			? pauseReason(input.state)
			: `${input.state.stage} stage ${formatDuration(currentStageActiveMs(input.state, input.displayActiveMs))}`,
		`${input.state.stage}/${input.state.step}`,
		theme.fg("dim", "· /planner-dashboard"),
	];
	return parts.join(" ");
}

function buildTimerWidgetLines(input: {
	ctx: ExtensionContext;
	state: PlanStateRecord;
	displayActiveMs: number;
	status: "active" | "paused" | "finished";
	settings: PlannerTimerSettings;
}): string[] {
	const timer = input.state.timer;
	const width = 40;
	const title = "PLANNER";
	const stateLabel =
		input.status === "active"
			? "RUN"
			: input.status === "paused"
				? "WAIT"
				: "DONE";
	const clock = formatClock(input.displayActiveMs);
	const checkpointTrail = timer
		? timer.checkpoints
				.slice(-input.settings.maxCheckpoints)
				.map((checkpoint) => checkpoint.stage)
				.join(" -> ")
		: input.state.stage;
	const lines = [
		`+${"-".repeat(width - 2)}+`,
		`| ${padRight(title, 12)}${padRight(stateLabel, 8)}${padLeft(clock, width - 24)} |`,
		`| ${padRight(`${input.state.stage}/${input.state.step}`, width - 4)} |`,
		`| ${padRight(input.status === "paused" ? pauseReason(input.state) : `stage ${formatDuration(currentStageActiveMs(input.state, input.displayActiveMs))}`, width - 4)} |`,
	];
	if (input.settings.showCheckpoints && checkpointTrail) {
		lines.push(`| ${padRight(`route ${checkpointTrail}`, width - 4)} |`);
	}
	lines.push(`| ${padRight("/planner-dashboard for stats", width - 4)} |`);
	lines.push(`+${"-".repeat(width - 2)}+`);
	return lines;
}

function pauseReason(state: PlanStateRecord): string {
	if (state.requiresUserDecision) return "waiting for user decision";
	if (state.requiresCompact)
		return `compact pending at ${state.stage}/${state.step}`;
	if (state.stage === "intake") return "waiting for goal approval";
	if (
		state.stage === "discovery" &&
		state.step === "write_questions" &&
		state.questionsSubmitted &&
		!state.questionsResolved
	) {
		return "waiting for question answers";
	}
	if (state.stage === "done") return "waiting for user acceptance";
	return "waiting";
}

function currentStageActiveMs(
	state: PlanStateRecord,
	displayActive: number,
): number {
	const checkpoint = state.timer?.checkpoints
		.slice()
		.reverse()
		.find((candidate) => candidate.stage === state.stage);
	return Math.max(0, displayActive - (checkpoint?.activeMs ?? 0));
}

function formatClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) {
		return `00:${totalSeconds.toString().padStart(2, "0")}`;
	}
	const totalMinutes = Math.floor(totalSeconds / 60);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

function padRight(value: string, width: number): string {
	if (value.length >= width) return value.slice(0, width);
	return `${value}${" ".repeat(width - value.length)}`;
}

function padLeft(value: string, width: number): string {
	if (value.length >= width) return value.slice(0, width);
	return `${" ".repeat(width - value.length)}${value}`;
}

function syncIntervalMs(settings: PlannerTimerSettings): number {
	return settings.syncIntervalMinutes * MS_PER_MINUTE;
}

function setPlannerStatus(
	ctx: ExtensionContext,
	value: string | undefined,
): void {
	try {
		ctx.ui.setStatus(TIMER_STATUS_KEY, value);
	} catch {
		// Stale UI contexts are possible during session replacement.
	}
}

function setPlannerWidget(
	ctx: ExtensionContext,
	value: string[] | undefined,
): void {
	try {
		ctx.ui.setWidget(TIMER_WIDGET_KEY, value, { placement: "belowEditor" });
	} catch {
		// Stale UI contexts are possible during session replacement.
	}
}

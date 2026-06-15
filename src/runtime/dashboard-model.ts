import {
	PLANNER_STAGE_STEPS,
	type PlannerStage,
	type PlannerStep,
	type PlanStateRecord,
	type PlanStatus,
	type StepStatus,
	type TaskStatus,
} from "../storage/schema";
import type { ActivePlanContext } from "./active-plan";

/**
 * Pure data + rendering layer for the planner dashboard TUI.
 *
 * Everything here is free of terminal/theme imports so it can be unit tested
 * with an identity palette. The interactive component in dashboard.ts injects a
 * real palette (theme colors + ANSI-aware width helpers) and terminal size.
 */

export const DASHBOARD_STAGE_SEQUENCE = [
	"init",
	"intake",
	"discovery",
	"planning",
	"execution",
	"finalize",
	"done",
] as const satisfies readonly PlannerStage[];

const STAGE_LABEL: Record<PlannerStage, string> = {
	init: "INIT",
	intake: "INTAKE",
	discovery: "DISCOVERY",
	planning: "PLANNING",
	execution: "EXECUTION",
	finalize: "FINALIZE",
	done: "DONE",
	recovery: "RECOVERY",
};

export type DashboardStatusLabel =
	| "run"
	| "wait"
	| "done"
	| "stuck"
	| "recovery";

export interface DashboardTaskRow {
	taskId: string;
	title: string;
	status: TaskStatus;
	isActive: boolean;
}

export interface DashboardStageTiming {
	stage: PlannerStage;
	activeMs: number;
	isCurrent: boolean;
}

export interface DashboardModel {
	available: true;
	planId: string;
	planTitle: string;
	planStatus: PlanStatus;
	stage: PlannerStage;
	step: PlannerStep;
	stepStatus: StepStatus;
	/** Index of the highlighted stage within DASHBOARD_STAGE_SEQUENCE. */
	stageIndex: number;
	/** Index of the current step within its stage (0-based). */
	stepIndex: number;
	/** Total steps in the current stage. */
	stepCount: number;
	/** Overall progress across all stages, 0..1. */
	overallRatio: number;
	/** Progress within the current stage, 0..1. */
	stageRatio: number;
	recovery: boolean;
	blocked: boolean;
	stuck: boolean;
	statusLabel: DashboardStatusLabel;
	activeTaskId: string | null;
	currentBranch: string | null;
	tasks: DashboardTaskRow[];
	tasksDone: number;
	tasksTotal: number;
	totalActiveMs: number;
	timings: DashboardStageTiming[];
	routeTrail: PlannerStage[];
	note: string | null;
}

export interface DashboardUnavailable {
	available: false;
	reason: string;
	hint: string;
}

export type PlannerDashboardModel = DashboardModel | DashboardUnavailable;

export interface DashboardPalette {
	text(s: string): string;
	accent(s: string): string;
	muted(s: string): string;
	dim(s: string): string;
	success(s: string): string;
	warning(s: string): string;
	error(s: string): string;
	border(s: string): string;
	bold(s: string): string;
	inverse(s: string): string;
	stage(stage: PlannerStage, s: string): string;
	/** Visible width of a string, ignoring ANSI escapes. */
	measure(s: string): number;
	/** Truncate to a visible width, ANSI-safe. */
	clip(s: string, width: number): string;
}

export interface DashboardUiState {
	selectedIndex: number;
	taskScroll: number;
	tickerOffset: number;
	focus: "tasks" | "ribbon";
}

export function buildPlannerDashboardModel(input: {
	context: ActivePlanContext;
	now: number;
}): PlannerDashboardModel {
	const { context } = input;
	if (context.status !== "ready") {
		return {
			available: false,
			reason: unavailableReason(context.status),
			hint:
				context.status === "no_active_plan" ||
				context.status === "missing_project"
					? "Run /planner-create to start a plan, then reopen this dashboard."
					: "Run /planner-resume to restore the active plan worktree.",
		};
	}

	const state = context.state;
	const recovery = state.stage === "recovery";
	const routeTrail = buildRouteTrail(state);
	const effectiveStage = recovery
		? lastSequencedStage(routeTrail)
		: state.stage;
	const stageIndex = DASHBOARD_STAGE_SEQUENCE.indexOf(
		effectiveStage as (typeof DASHBOARD_STAGE_SEQUENCE)[number],
	);
	const stageSteps = PLANNER_STAGE_STEPS[state.stage] as readonly PlannerStep[];
	const stepIndex = Math.max(0, stageSteps.indexOf(state.step));
	const stepCount = stageSteps.length;
	const stageRatio = recovery
		? 0
		: clamp01(
				(stepIndex + (state.stepStatus === "completed" ? 1 : 0.5)) / stepCount,
			);
	const overallRatio = computeOverallRatio(stageIndex, stageRatio, recovery);

	const tasks: DashboardTaskRow[] = context.plan.tasks.map((task) => ({
		taskId: task.taskId,
		title: task.title,
		status: task.status,
		isActive: task.taskId === state.activeTaskId,
	}));
	const tasksDone = tasks.filter((task) => task.status === "done").length;

	const totalActiveMs = state.timer?.activeMs ?? 0;
	const timings = buildStageTimings(state, totalActiveMs, effectiveStage);

	const stuck = !recovery && state.lastStuckAttemptId !== null;
	const blocked =
		state.broken || state.requiresUserDecision || state.blockedReason !== null;
	const statusLabel = deriveStatusLabel({
		recovery,
		stuck,
		planStatus: context.plan.status,
		stage: state.stage,
		blocked,
	});

	return {
		available: true,
		planId: context.activePlanId,
		planTitle: context.plan.title,
		planStatus: context.plan.status,
		stage: state.stage,
		step: state.step,
		stepStatus: state.stepStatus,
		stageIndex,
		stepIndex,
		stepCount,
		overallRatio,
		stageRatio,
		recovery,
		blocked,
		stuck,
		statusLabel,
		activeTaskId: state.activeTaskId,
		currentBranch: state.currentBranch,
		tasks,
		tasksDone,
		tasksTotal: tasks.length,
		totalActiveMs,
		timings,
		routeTrail,
		note: state.brokenReason ?? state.blockedReason ?? null,
	};
}

function deriveStatusLabel(input: {
	recovery: boolean;
	stuck: boolean;
	planStatus: PlanStatus;
	stage: PlannerStage;
	blocked: boolean;
}): DashboardStatusLabel {
	if (input.recovery) return "recovery";
	if (input.stuck) return "stuck";
	if (input.planStatus === "done" || input.stage === "done") return "done";
	if (input.blocked) return "wait";
	return "run";
}

function buildRouteTrail(state: PlanStateRecord): PlannerStage[] {
	const checkpoints = state.timer?.checkpoints ?? [];
	const trail: PlannerStage[] = [];
	for (const checkpoint of checkpoints) {
		if (trail[trail.length - 1] !== checkpoint.stage) {
			trail.push(checkpoint.stage);
		}
	}
	if (trail[trail.length - 1] !== state.stage) {
		trail.push(state.stage);
	}
	return trail;
}

function lastSequencedStage(trail: PlannerStage[]): PlannerStage {
	for (let i = trail.length - 1; i >= 0; i--) {
		const stage = trail[i];
		if (stage !== "recovery") return stage;
	}
	return "init";
}

function buildStageTimings(
	state: PlanStateRecord,
	totalActiveMs: number,
	currentStage: PlannerStage,
): DashboardStageTiming[] {
	const checkpoints = state.timer?.checkpoints ?? [];
	const perStage = new Map<PlannerStage, number>();
	for (let i = 0; i < checkpoints.length; i++) {
		const start = checkpoints[i].activeMs;
		const end = checkpoints[i + 1]?.activeMs ?? totalActiveMs;
		const delta = Math.max(0, end - start);
		perStage.set(
			checkpoints[i].stage,
			(perStage.get(checkpoints[i].stage) ?? 0) + delta,
		);
	}
	if (perStage.size === 0 && totalActiveMs > 0) {
		perStage.set(state.stage, totalActiveMs);
	}
	const order: PlannerStage[] = [...DASHBOARD_STAGE_SEQUENCE];
	if (state.stage === "recovery") order.push("recovery");
	return order
		.filter((stage) => perStage.has(stage))
		.map((stage) => ({
			stage,
			activeMs: perStage.get(stage) ?? 0,
			isCurrent: stage === currentStage || stage === state.stage,
		}));
}

function computeOverallRatio(
	stageIndex: number,
	stageRatio: number,
	recovery: boolean,
): number {
	if (stageIndex < 0) return 0;
	const total = DASHBOARD_STAGE_SEQUENCE.length;
	const base = (stageIndex + (recovery ? 0 : stageRatio)) / total;
	return clamp01(base);
}

function unavailableReason(status: ActivePlanContext["status"]): string {
	switch (status) {
		case "missing_project":
			return "No planner project exists for this directory yet.";
		case "no_active_plan":
			return "No active planner plan.";
		case "missing_plan":
			return "The active plan record is missing.";
		case "missing_state":
			return "The active plan runtime state is missing.";
		default:
			return "Planner dashboard is unavailable.";
	}
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const MIN_FULL_WIDTH = 64;
const MIN_FULL_HEIGHT = 18;

export function composeDashboard(input: {
	model: PlannerDashboardModel;
	width: number;
	height: number;
	palette: DashboardPalette;
	ui: DashboardUiState;
}): string[] {
	const { model, palette } = input;
	const width = Math.max(20, Math.floor(input.width));
	const height = Math.max(8, Math.floor(input.height));
	const inner = width - 2;

	if (!model.available) {
		return frame({
			palette,
			width,
			height,
			title: "Planner for Local Models",
			clock: "",
			body: renderUnavailable(model, inner, palette),
		});
	}

	const compact = width < MIN_FULL_WIDTH || height < MIN_FULL_HEIGHT;
	const clock = formatClock(model.totalActiveMs);
	const body = compact
		? renderCompactBody({ model, inner, height, palette, ui: input.ui })
		: renderFullBody({ model, inner, height, palette, ui: input.ui });

	return frame({
		palette,
		width,
		height,
		title: dashboardTitle(model),
		clock,
		body,
	});
}

function dashboardTitle(model: DashboardModel): string {
	return `Planner · ${model.planTitle}`;
}

function renderUnavailable(
	model: DashboardUnavailable,
	inner: number,
	palette: DashboardPalette,
): string[] {
	return [
		"",
		padTo(palette.warning(model.reason), inner, palette),
		"",
		padTo(palette.dim(model.hint), inner, palette),
		"",
		padTo(palette.dim("Press q or esc to close."), inner, palette),
	];
}

interface BodyInput {
	model: DashboardModel;
	inner: number;
	height: number;
	palette: DashboardPalette;
	ui: DashboardUiState;
}

function renderFullBody(input: BodyInput): string[] {
	const { model, inner, palette, ui } = input;
	const lines: string[] = [];
	// Header line: status + step position.
	lines.push(renderHeaderLine(model, inner, palette));
	lines.push(blank(inner, palette));
	// Stage ribbon (progress bar) + ticker.
	lines.push(...renderStageRibbon(model, inner, palette));
	lines.push(renderTicker(model, inner, ui.tickerOffset, palette));
	lines.push(divider(inner, palette));

	// Body height available for the two-column area.
	// frame uses: top + header(1) + blank(1) + ribbon(2) + ticker(1) +
	// divider(1) ... + help(1) + bottom. Reserve rows for help + already pushed.
	const used = lines.length;
	const reserveBelow = 2; // help line + spacing
	const columnHeight = Math.max(
		3,
		input.height - 2 /* borders */ - used - reserveBelow,
	);

	const leftWidth = Math.max(22, Math.floor(inner * 0.42));
	const rightWidth = inner - leftWidth - 3; // 3 = " │ " separator
	const left = renderTaskColumn(model, {
		width: leftWidth,
		height: columnHeight,
		palette,
		ui,
	});
	const right = renderDetailColumn(model, {
		width: rightWidth,
		height: columnHeight,
		palette,
	});

	for (let i = 0; i < columnHeight; i++) {
		const l = padTo(left[i] ?? "", leftWidth, palette);
		const r = padTo(right[i] ?? "", rightWidth, palette);
		lines.push(`${l} ${palette.border("│")} ${r}`);
	}

	lines.push(blank(inner, palette));
	lines.push(renderHelpLine(inner, palette, ui));
	return lines;
}

function renderCompactBody(input: BodyInput): string[] {
	const { model, inner, palette, ui } = input;
	const lines: string[] = [];
	lines.push(renderHeaderLine(model, inner, palette));
	lines.push(...renderStageRibbon(model, inner, palette));
	lines.push(renderTicker(model, inner, ui.tickerOffset, palette));
	lines.push(divider(inner, palette));

	const used = lines.length;
	const reserveBelow = 1;
	const listHeight = Math.max(2, input.height - 2 - used - reserveBelow);
	lines.push(
		...renderTaskColumn(model, {
			width: inner,
			height: listHeight,
			palette,
			ui,
		}),
	);
	lines.push(renderHelpLine(inner, palette, ui));
	return lines;
}

/**
 * Compact top band for the workspace: header + stage ribbon + ticker.
 * Returns content lines only (no outer frame).
 */
export function renderDashboardBand(
	model: PlannerDashboardModel,
	inner: number,
	tickerOffset: number,
	palette: DashboardPalette,
): string[] {
	if (!model.available) {
		return [padTo(palette.warning(model.reason), inner, palette)];
	}
	return [
		renderHeaderLine(model, inner, palette),
		...renderStageRibbon(model, inner, palette),
		renderTicker(model, inner, tickerOffset, palette),
	];
}

/**
 * Expanded dashboard area: task list + detail/timings columns.
 * Returns exactly `height` content lines (no outer frame).
 */
export function renderDashboardColumns(
	model: DashboardModel,
	inner: number,
	height: number,
	palette: DashboardPalette,
	ui: DashboardUiState,
): string[] {
	const leftWidth = Math.max(22, Math.floor(inner * 0.42));
	const rightWidth = inner - leftWidth - 3;
	const left = renderTaskColumn(model, {
		width: leftWidth,
		height,
		palette,
		ui,
	});
	const right = renderDetailColumn(model, {
		width: rightWidth,
		height,
		palette,
	});
	const lines: string[] = [];
	for (let i = 0; i < height; i++) {
		const l = padTo(left[i] ?? "", leftWidth, palette);
		const r = padTo(right[i] ?? "", rightWidth, palette);
		lines.push(`${l} ${palette.border("│")} ${r}`);
	}
	return lines;
}

function renderHeaderLine(
	model: DashboardModel,
	inner: number,
	palette: DashboardPalette,
): string {
	const badge = statusBadge(model.statusLabel, palette);
	const position = model.recovery
		? palette.error("RECOVERY")
		: palette.muted(
				`${STAGE_LABEL[model.stage]} ${palette.dim("·")} step ${model.stepIndex + 1}/${model.stepCount}`,
			);
	const left = `${badge} ${position}`;
	const tasks = palette.dim(`tasks ${model.tasksDone}/${model.tasksTotal}`);
	return spread(left, tasks, inner, palette);
}

export function renderStageRibbon(
	model: DashboardModel,
	width: number,
	palette: DashboardPalette,
): string[] {
	const sep = palette.dim(" › ");
	const parts = DASHBOARD_STAGE_SEQUENCE.map((stage, index) => {
		const label = STAGE_LABEL[stage];
		if (index === model.stageIndex && !model.recovery) {
			// Active stage: bracketed + bold in the stage colour.
			return palette.bold(palette.stage(stage, `[${label}]`));
		}
		if (index < model.stageIndex) {
			// Completed stage: stage colour.
			return palette.stage(stage, label);
		}
		// Pending stage: dimmed.
		return palette.dim(label);
	});
	return [padTo(parts.join(sep), width, palette)];
}

export function renderTicker(
	model: DashboardModel,
	width: number,
	offset: number,
	palette: DashboardPalette,
): string {
	const segments: string[] = [];
	if (model.recovery) {
		segments.push("RECOVERY MODE — resolve before resuming");
	}
	segments.push(`${model.stage}/${model.step} (${model.stepStatus})`);
	if (model.activeTaskId) {
		const title = taskTitle(model, model.activeTaskId);
		segments.push(`task ${model.activeTaskId}${title ? `: ${title}` : ""}`);
	}
	if (model.currentBranch) segments.push(`branch ${model.currentBranch}`);
	if (model.note) segments.push(`note: ${model.note}`);
	segments.push(`route ${model.routeTrail.join(" → ")}`);

	const gap = "   •   ";
	const full = segments.join(gap) + gap;
	const fullWidth = full.length;
	let windowText: string;
	if (fullWidth <= width) {
		windowText = full;
	} else {
		const start = ((offset % fullWidth) + fullWidth) % fullWidth;
		const doubled = full + full;
		windowText = doubled.slice(start, start + width);
	}
	return padTo(palette.muted(windowText), width, palette);
}

interface ColumnInput {
	width: number;
	height: number;
	palette: DashboardPalette;
	ui: DashboardUiState;
}

export function renderTaskColumn(
	model: DashboardModel,
	input: ColumnInput,
): string[] {
	const { width, height, palette, ui } = input;
	const lines: string[] = [];
	const headerFocus =
		ui.focus === "tasks" ? palette.accent("TASKS") : palette.muted("TASKS");
	lines.push(
		spread(
			headerFocus,
			palette.dim(`${model.tasksDone}/${model.tasksTotal} done`),
			width,
			palette,
		),
	);

	const rowsAvailable = Math.max(1, height - 1);
	if (model.tasks.length === 0) {
		lines.push(padTo(palette.dim("(no tasks yet)"), width, palette));
		return fillColumn(lines, height, width, palette);
	}

	// Auto-follow the selection so the highlighted task is always visible,
	// keeping it roughly centred within the visible window.
	const centered = ui.selectedIndex - Math.floor(rowsAvailable / 2);
	const scroll = clampScroll(centered, model.tasks.length, rowsAvailable);
	const end = Math.min(model.tasks.length, scroll + rowsAvailable);
	for (let i = scroll; i < end; i++) {
		lines.push(
			renderTaskRow(model.tasks[i], i === ui.selectedIndex, width, palette),
		);
	}
	if (model.tasks.length > rowsAvailable) {
		const lastLine = lines.length - 1;
		const indicator = palette.dim(
			`${Math.min(end, model.tasks.length)}/${model.tasks.length}`,
		);
		lines[lastLine] = spread(
			stripTrailing(lines[lastLine], palette),
			indicator,
			width,
			palette,
		);
	}
	return fillColumn(lines, height, width, palette);
}

function renderTaskRow(
	task: DashboardTaskRow,
	selected: boolean,
	width: number,
	palette: DashboardPalette,
): string {
	const cursor = selected ? palette.accent("▸") : " ";
	const icon = taskStatusIcon(task.status, palette);
	const idAndTitle = `${task.taskId} ${task.title}`;
	const prefixWidth = 4; // cursor + space + icon + space
	const body = palette.clip(
		selected
			? palette.bold(idAndTitle)
			: task.isActive
				? palette.text(idAndTitle)
				: palette.muted(idAndTitle),
		Math.max(1, width - prefixWidth),
	);
	return padTo(`${cursor} ${icon} ${body}`, width, palette);
}

function taskStatusIcon(status: TaskStatus, palette: DashboardPalette): string {
	switch (status) {
		case "done":
			return palette.success("✓");
		case "active":
			return palette.accent("●");
		case "blocked":
			return palette.error("✗");
		default:
			return palette.dim("○");
	}
}

export function renderDetailColumn(
	model: DashboardModel,
	input: { width: number; height: number; palette: DashboardPalette },
): string[] {
	const { width, height, palette } = input;
	const lines: string[] = [];
	lines.push(
		spread(
			palette.muted("CURRENT"),
			statusBadge(model.statusLabel, palette),
			width,
			palette,
		),
	);
	lines.push(
		padTo(palette.text(`${model.stage} / ${model.step}`), width, palette),
	);
	lines.push(
		padTo(
			palette.dim(`step ${model.stepIndex + 1} of ${model.stepCount}`),
			width,
			palette,
		),
	);
	if (model.activeTaskId) {
		lines.push(
			padTo(palette.dim(`task ${model.activeTaskId}`), width, palette),
		);
	}
	if (model.currentBranch) {
		lines.push(
			padTo(
				palette.dim(palette.clip(`↳ ${model.currentBranch}`, width)),
				width,
				palette,
			),
		);
	}
	lines.push(blank(width, palette));
	lines.push(padTo(palette.muted("STAGE TIMINGS"), width, palette));
	for (const timing of model.timings) {
		const name = STAGE_LABEL[timing.stage].toLowerCase().padEnd(10);
		const clock = formatDuration(timing.activeMs);
		const marker = timing.isCurrent ? palette.accent(" ◂ now") : "";
		const line = `${name} ${clock}${marker}`;
		lines.push(
			padTo(
				timing.isCurrent ? palette.text(line) : palette.dim(line),
				width,
				palette,
			),
		);
	}
	if (model.note) {
		lines.push(blank(width, palette));
		lines.push(
			padTo(palette.warning(palette.clip(model.note, width)), width, palette),
		);
	}
	return fillColumn(lines, height, width, palette);
}

function renderHelpLine(
	inner: number,
	palette: DashboardPalette,
	ui: DashboardUiState,
): string {
	const tab =
		ui.focus === "tasks"
			? `${palette.accent("tasks")} ${palette.dim("ribbon")}`
			: `${palette.dim("tasks")} ${palette.accent("ribbon")}`;
	const keys = palette.dim(
		"↑↓ select · ←→ scroll · tab focus · r refresh · q/esc close",
	);
	return spread(tab, keys, inner, palette);
}

function statusBadge(
	label: DashboardStatusLabel,
	palette: DashboardPalette,
): string {
	switch (label) {
		case "run":
			return palette.success("● RUN");
		case "wait":
			return palette.warning("⏸ WAIT");
		case "done":
			return palette.success("✓ DONE");
		case "stuck":
			return palette.error("▲ STUCK");
		case "recovery":
			return palette.error("⟳ RECOVERY");
	}
}

// ---------------------------------------------------------------------------
// Frame + layout primitives
// ---------------------------------------------------------------------------

/** Wrap body content lines in the planner frame (title + clock + borders). */
export function frameWorkspace(input: {
	palette: DashboardPalette;
	width: number;
	height: number;
	title: string;
	clock: string;
	body: string[];
}): string[] {
	return frame(input);
}

/** Inner divider line (full inner width). */
export function dashboardDivider(
	inner: number,
	palette: DashboardPalette,
): string {
	return divider(inner, palette);
}

function frame(input: {
	palette: DashboardPalette;
	width: number;
	height: number;
	title: string;
	clock: string;
	body: string[];
}): string[] {
	const { palette, width, height } = input;
	const inner = width - 2;
	const top = renderTopBorder(input.title, input.clock, inner, palette);
	const bottom = palette.border(`╰${"─".repeat(inner)}╯`);

	const bodyHeight = Math.max(0, height - 2);
	const body: string[] = [];
	for (let i = 0; i < bodyHeight; i++) {
		const line = input.body[i] ?? blank(inner, palette);
		body.push(
			`${palette.border("│")}${padTo(line, inner, palette)}${palette.border("│")}`,
		);
	}
	return [top, ...body, bottom];
}

function renderTopBorder(
	title: string,
	clock: string,
	inner: number,
	palette: DashboardPalette,
): string {
	const titleText = palette.clip(` ${title} `, Math.max(0, inner - 4));
	const clockText = clock ? ` ${clock} ` : "";
	const dashes = Math.max(
		0,
		inner - palette.measure(titleText) - palette.measure(clockText) - 2,
	);
	return (
		palette.border("╭─") +
		palette.bold(palette.accent(titleText)) +
		palette.border("─".repeat(dashes)) +
		(clock ? palette.dim(clockText) : "") +
		palette.border("─╮")
	);
}

function divider(inner: number, palette: DashboardPalette): string {
	return palette.border("─".repeat(inner));
}

function blank(width: number, palette: DashboardPalette): string {
	return padTo("", width, palette);
}

function fillColumn(
	lines: string[],
	height: number,
	width: number,
	palette: DashboardPalette,
): string[] {
	const out = lines.slice(0, height);
	while (out.length < height) out.push(blank(width, palette));
	return out.map((line) => padTo(line, width, palette));
}

function padTo(
	value: string,
	width: number,
	palette: DashboardPalette,
): string {
	const clipped = palette.clip(value, width);
	const pad = Math.max(0, width - palette.measure(clipped));
	return clipped + " ".repeat(pad);
}

function spread(
	left: string,
	right: string,
	width: number,
	palette: DashboardPalette,
): string {
	const lw = palette.measure(left);
	const rw = palette.measure(right);
	if (lw + rw + 1 > width) {
		return padTo(left, width, palette);
	}
	const gap = width - lw - rw;
	return left + " ".repeat(gap) + right;
}

function stripTrailing(line: string, palette: DashboardPalette): string {
	// Best-effort: trim trailing spaces so spread can re-justify.
	let end = line.length;
	while (end > 0 && line[end - 1] === " ") end--;
	void palette;
	return line.slice(0, end);
}

function taskTitle(model: DashboardModel, taskId: string): string {
	return model.tasks.find((task) => task.taskId === taskId)?.title ?? "";
}

function clampScroll(scroll: number, total: number, visible: number): number {
	const maxScroll = Math.max(0, total - visible);
	return Math.min(Math.max(0, scroll), maxScroll);
}

function clamp01(value: number): number {
	if (Number.isNaN(value)) return 0;
	return Math.min(1, Math.max(0, value));
}

export function formatClock(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return [hours, minutes, seconds]
		.map((value) => value.toString().padStart(2, "0"))
		.join(":");
}

export function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes.toString().padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
	return `${seconds}s`;
}

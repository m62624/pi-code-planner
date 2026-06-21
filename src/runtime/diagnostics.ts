import { join } from "node:path";
import type { PlannerFs } from "../storage/fs";
import type { PlanStoragePaths } from "../storage/paths";
import type { PlanRecord, PlanStateRecord } from "../storage/schema";

// The diagnostics sidecar records the planner's own control flow so a stuck
// state machine can be reported upstream without ever touching project content.
// It is intentionally decoupled from state.json (no schema migration) and lives
// in the plan artifacts dir, outside the user's repository.
//
// Confidentiality model:
// - The sidecar (diagnostics.json) holds RAW ids. It is local-only and is never
//   attached to anything — it stays in the plan artifacts dir.
// - The generated report (report-*.md) is PSEUDONYMIZED (task ids -> T1, T2 …)
//   and is the only file meant for attaching to an issue.
// - The legend (legend-*.md) maps token -> real id. Local-only; the user may use
//   it to de-anonymize before filing, but it is not part of the report.

export const DIAGNOSTICS_SCHEMA_VERSION = 1 as const;

/** Keep the timeline bounded; a stuck model can emit hundreds of calls. */
export const MAX_TOOL_TIMELINE = 200;

export type PlannerToolStatus = "applied" | "blocked" | "error";

export interface PlannerToolEvent {
	ts: number;
	/** planner_* tool name only — never arguments or results. */
	tool: string;
	status: PlannerToolStatus;
	stage: string | null;
	step: string | null;
	/** Raw active task id at the time (pseudonymized only when reporting). */
	task: string | null;
}

export interface PlannerDiagnosticsRecord {
	schemaVersion: typeof DIAGNOSTICS_SCHEMA_VERSION;
	toolTimeline: PlannerToolEvent[];
	/** Blocked planner results since the last applied (progress) result. */
	consecutiveBlocked: number;
	/** Wall-clock ms of the first blocked result in the current stuck streak. */
	firstBlockedAt: number | null;
	/** Step that was running when the current stuck streak began. */
	lastBlockedStep: string | null;
	/** How many times any recovery wrapper was invoked. */
	recoveryCalls: number;
}

const RECOVERY_TOOLS = new Set([
	"planner_recovery_inspect",
	"planner_recovery_resume",
	"planner_recovery_report",
]);

export function createDiagnosticsRecord(): PlannerDiagnosticsRecord {
	return {
		schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
		toolTimeline: [],
		consecutiveBlocked: 0,
		firstBlockedAt: null,
		lastBlockedStep: null,
		recoveryCalls: 0,
	};
}

function diagnosticsFilePath(planPaths: PlanStoragePaths): string {
	return join(planPaths.diagnosticsDir, "diagnostics.json");
}

export async function readDiagnosticsRecord(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
): Promise<PlannerDiagnosticsRecord> {
	const path = diagnosticsFilePath(planPaths);
	if (!(await fs.exists(path))) {
		return createDiagnosticsRecord();
	}
	try {
		const parsed = JSON.parse(await fs.readText(path)) as unknown;
		return normalizeDiagnosticsRecord(parsed);
	} catch {
		// A corrupt sidecar must never break the planner; start fresh.
		return createDiagnosticsRecord();
	}
}

function normalizeDiagnosticsRecord(value: unknown): PlannerDiagnosticsRecord {
	const base = createDiagnosticsRecord();
	if (!value || typeof value !== "object") return base;
	const record = value as Partial<PlannerDiagnosticsRecord>;
	return {
		schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
		toolTimeline: Array.isArray(record.toolTimeline)
			? record.toolTimeline.slice(-MAX_TOOL_TIMELINE)
			: [],
		consecutiveBlocked:
			typeof record.consecutiveBlocked === "number"
				? record.consecutiveBlocked
				: 0,
		firstBlockedAt:
			typeof record.firstBlockedAt === "number" ? record.firstBlockedAt : null,
		lastBlockedStep:
			typeof record.lastBlockedStep === "string"
				? record.lastBlockedStep
				: null,
		recoveryCalls:
			typeof record.recoveryCalls === "number" ? record.recoveryCalls : 0,
	};
}

async function writeDiagnosticsRecord(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	record: PlannerDiagnosticsRecord,
): Promise<void> {
	await fs.mkdirp(planPaths.diagnosticsDir);
	await fs.writeTextAtomic(
		diagnosticsFilePath(planPaths),
		`${JSON.stringify(record, null, 2)}\n`,
	);
}

/**
 * Apply one planner tool result to a diagnostics record. Pure so the counter
 * logic can be tested without the filesystem.
 *
 * Counter semantics (the false-positive-resistant heuristic):
 * - `applied` results RESET the blocked streak — legitimately repeated commands
 *   (e.g. several contract reads) are applied, so they never accumulate.
 * - `blocked`/`error` results GROW the streak — a model that alternates many
 *   commands but makes no progress trips the threshold regardless of the
 *   specific pattern.
 */
export function applyToolEvent(
	record: PlannerDiagnosticsRecord,
	event: PlannerToolEvent,
): PlannerDiagnosticsRecord {
	const toolTimeline = [...record.toolTimeline, event].slice(
		-MAX_TOOL_TIMELINE,
	);
	const recoveryCalls = RECOVERY_TOOLS.has(event.tool)
		? record.recoveryCalls + 1
		: record.recoveryCalls;

	if (event.status === "applied") {
		return {
			...record,
			toolTimeline,
			recoveryCalls,
			consecutiveBlocked: 0,
			firstBlockedAt: null,
			lastBlockedStep: null,
		};
	}

	return {
		...record,
		toolTimeline,
		recoveryCalls,
		consecutiveBlocked: record.consecutiveBlocked + 1,
		firstBlockedAt: record.firstBlockedAt ?? event.ts,
		lastBlockedStep: record.lastBlockedStep ?? event.step,
	};
}

export async function recordPlannerToolEvent(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	event: PlannerToolEvent,
): Promise<PlannerDiagnosticsRecord> {
	const record = await readDiagnosticsRecord(fs, planPaths);
	const next = applyToolEvent(record, event);
	await writeDiagnosticsRecord(fs, planPaths, next);
	return next;
}

export interface StuckThresholds {
	/** Blocked planner results in a row that count as stuck. */
	blockedTransitions: number;
	/** Wall-clock ms since the first block that counts as stuck. */
	stuckMs: number;
}

export interface StuckEvaluation {
	stuck: boolean;
	reasons: string[];
}

/**
 * Decide whether the planner looks stuck. Three independent signals, any of
 * which fires — chosen to avoid the naive "same tool N times" check, which both
 * misses alternating loops and false-fires on legitimately repeated commands.
 */
export function evaluatePlannerStuck(
	record: PlannerDiagnosticsRecord,
	now: number,
	thresholds: StuckThresholds,
): StuckEvaluation {
	const reasons: string[] = [];
	if (record.consecutiveBlocked >= thresholds.blockedTransitions) {
		reasons.push(
			`${record.consecutiveBlocked} blocked planner transitions in a row without progress`,
		);
	}
	if (
		record.firstBlockedAt !== null &&
		now - record.firstBlockedAt >= thresholds.stuckMs
	) {
		const minutes = Math.round((now - record.firstBlockedAt) / 60_000);
		reasons.push(
			`stuck for ~${minutes} min since the first blocked transition`,
		);
	}
	if (record.recoveryCalls >= 1) {
		reasons.push(
			`${record.recoveryCalls} recovery wrapper call(s) — the model already entered recovery`,
		);
	}
	return { stuck: reasons.length > 0, reasons };
}

// --- Sanitization + pseudonymization -------------------------------------

/** Stable token allocator: real id -> T1, T2, … in first-seen order. */
export interface Pseudonymizer {
	token(id: string | null | undefined): string | null;
	legend(): Array<{ token: string; realId: string }>;
}

export function createPseudonymizer(): Pseudonymizer {
	const map = new Map<string, string>();
	return {
		token(id) {
			if (!id) return null;
			const existing = map.get(id);
			if (existing) return existing;
			const token = `T${map.size + 1}`;
			map.set(id, token);
			return token;
		},
		legend() {
			return [...map.entries()].map(([realId, token]) => ({ token, realId }));
		},
	};
}

export interface SanitizedPlanState {
	stage: string;
	step: string;
	stepStatus: string;
	nextStep: string | null;
	broken: boolean;
	brokenReasonPresent: boolean;
	questionsSubmitted: boolean;
	questionsResolved: boolean;
	compactBoundaries: { stage: boolean; task: boolean };
	activeTask: string | null;
	managedTasks: string[];
	branches: { base: boolean; plan: boolean; currentTask: boolean };
	mergeTargets: { taskToPlan: boolean; planToOutput: boolean };
}

/**
 * Reduce state.json to a generalized, machine-analysis snapshot. Drops every
 * free-text and path field; keeps only enums/booleans and pseudonymized task
 * ids. The pseudonymizer is shared with the timeline so tokens are consistent.
 */
export function sanitizePlanState(
	state: PlanStateRecord,
	pseudo: Pseudonymizer,
): SanitizedPlanState {
	return {
		stage: state.stage,
		step: state.step,
		stepStatus: state.stepStatus,
		nextStep: state.nextStep,
		broken: state.broken,
		brokenReasonPresent: state.brokenReason !== null,
		questionsSubmitted: state.questionsSubmitted,
		questionsResolved: state.questionsResolved,
		compactBoundaries: {
			stage: state.compactBoundaries.stage,
			task: state.compactBoundaries.task,
		},
		activeTask: pseudo.token(state.activeTaskId),
		managedTasks: Object.keys(state.managedBranches.tasks)
			.map((id) => pseudo.token(id))
			.filter((token): token is string => token !== null),
		branches: {
			// Branch names embed the plan id and task slug, so they are reduced to
			// presence booleans rather than pseudonymized (which would leak the raw
			// name into the legend).
			base: Boolean(state.activeBranches.base),
			plan: Boolean(state.activeBranches.plan),
			currentTask: state.activeBranches.currentTask !== null,
		},
		mergeTargets: {
			taskToPlan: state.mergeTargets.taskToPlan !== null,
			planToOutput: state.mergeTargets.planToOutput !== null,
		},
	};
}

export interface RecoveryReportInput {
	state: PlanStateRecord;
	plan: PlanRecord | null;
	diagnostics: PlannerDiagnosticsRecord;
	evaluation: StuckEvaluation;
	modelId: string | null;
	now: number;
	issueUrl: string;
}

export interface RecoveryReportArtifacts {
	report: string;
	legend: string;
}

export const RECOVERY_ISSUE_URL =
	"https://github.com/m62624/pi-code-planner/issues";

/**
 * Build the sanitized report markdown plus a local-only legend. Pure: no I/O, so
 * the exact output (and the absence of raw ids/paths) is fully testable.
 */
export function buildRecoveryReport(
	input: RecoveryReportInput,
): RecoveryReportArtifacts {
	const pseudo = createPseudonymizer();
	// Allocate tokens in chronological first-seen order so the report reads as a
	// stack trace; the timeline drives ordering, state/plan fill in the rest.
	for (const event of input.diagnostics.toolTimeline) {
		pseudo.token(event.task);
	}
	const sanitized = sanitizePlanState(input.state, pseudo);
	for (const task of input.plan?.tasks ?? []) {
		pseudo.token(task.taskId);
	}

	const minutesStuck =
		input.diagnostics.firstBlockedAt !== null
			? Math.round((input.now - input.diagnostics.firstBlockedAt) / 60_000)
			: 0;

	const taskStatusLine = (input.plan?.tasks ?? [])
		.map((task) => `${pseudo.token(task.taskId)}=${task.status}`)
		.join(", ");

	const timeline = input.diagnostics.toolTimeline
		.map((event, index) => {
			const task = pseudo.token(event.task);
			const where = event.step ? `[${event.stage ?? "?"}/${event.step}]` : "";
			const suffix = task ? ` (${task})` : "";
			return `${index + 1}. ${where} ${event.tool} → ${event.status}${suffix}`;
		})
		.join("\n");

	const report = [
		"# pi-code-planner recovery report",
		"",
		"> Confidentiality: this report contains ONLY planner tool names, their",
		"> applied/blocked status, and a generalized state-machine snapshot. No tool",
		"> arguments, file contents, code, paths, titles, or descriptions are",
		"> included. Task ids are pseudonymized (T1, T2 …). Please review this file",
		"> before attaching it to an issue and confirm there is nothing sensitive —",
		"> the maintainer cannot see what we may have missed.",
		"",
		`- model: ${input.modelId ?? "unknown — please fill in the model you were running"}`,
		`- generated: ${new Date(input.now).toISOString()}`,
		"- schema: planner-diagnostics v1",
		"",
		"## Why this report exists",
		"",
		"The planner detected that it was stuck and could not make progress. This is",
		"an abnormal condition in the extension's state machine — it is not",
		"necessarily a mistake in your project. The data below describes the planner",
		"control flow (which steps and transitions ran, in what order) so the",
		"maintainer can fix this stuck pattern for the future.",
		"",
		"## Detected signals",
		"",
		...input.evaluation.reasons.map((reason) => `- ${reason}`),
		`- consecutive blocked transitions: ${input.diagnostics.consecutiveBlocked}`,
		`- time since first block: ~${minutesStuck} min`,
		`- recovery wrapper calls: ${input.diagnostics.recoveryCalls}`,
		"",
		"## State snapshot (sanitized)",
		"",
		`- stage/step: ${sanitized.stage}/${sanitized.step} (${sanitized.stepStatus})`,
		`- nextStep: ${sanitized.nextStep ?? "(none)"}`,
		`- active task: ${sanitized.activeTask ?? "(none)"}`,
		`- managed tasks: ${sanitized.managedTasks.join(", ") || "(none)"}`,
		`- branches: base=${sanitized.branches.base} plan=${sanitized.branches.plan} currentTask=${sanitized.branches.currentTask}`,
		`- merge targets: taskToPlan=${sanitized.mergeTargets.taskToPlan} planToOutput=${sanitized.mergeTargets.planToOutput}`,
		`- gates: questionsSubmitted=${sanitized.questionsSubmitted} questionsResolved=${sanitized.questionsResolved} broken=${sanitized.broken}`,
		`- compactBoundaries: stage=${sanitized.compactBoundaries.stage} task=${sanitized.compactBoundaries.task}`,
		`- task statuses: ${taskStatusLine || "(none)"}`,
		"",
		"## Tool-call stack trace (names + status, no arguments)",
		"",
		timeline || "(no recorded planner tool calls)",
		"",
		"## How to file",
		"",
		`Create an issue at ${input.issueUrl} and attach this file. The legend file`,
		"(token → real id) is kept locally next to this report and is NOT part of it;",
		"do not attach the legend unless you have confirmed the ids are safe to share.",
		"",
	].join("\n");

	const legendRows = pseudo.legend();
	const legend = [
		"# Recovery report legend (LOCAL ONLY — do not attach unless verified)",
		"",
		"Maps pseudonymized tokens in report-*.md back to the real planner ids.",
		"",
		"| token | real id |",
		"| --- | --- |",
		...legendRows.map((row) => `| ${row.token} | ${row.realId} |`),
		"",
	].join("\n");

	return { report, legend };
}

export interface WrittenRecoveryReport {
	reportPath: string;
	legendPath: string;
}

/** Persist the report and legend into the plan diagnostics dir (outside the repo). */
export async function writeRecoveryReport(
	fs: PlannerFs,
	planPaths: PlanStoragePaths,
	planId: string,
	artifacts: RecoveryReportArtifacts,
): Promise<WrittenRecoveryReport> {
	await fs.mkdirp(planPaths.diagnosticsDir);
	const reportPath = join(planPaths.diagnosticsDir, `report-${planId}.md`);
	const legendPath = join(planPaths.diagnosticsDir, `legend-${planId}.md`);
	await fs.writeTextAtomic(reportPath, artifacts.report);
	await fs.writeTextAtomic(legendPath, artifacts.legend);
	return { reportPath, legendPath };
}

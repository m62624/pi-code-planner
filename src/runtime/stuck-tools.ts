import { join } from "node:path";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import { safeReaddir } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { updatePlanState } from "../storage/state-store";
import { readActivePlanContext } from "./active-plan";
import { initializePlannerDebugSession } from "./debug-tools";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import {
	boolean,
	enumOf,
	intRange,
	nonEmptyStringArray,
	objectOf,
	optionalString,
	type ParamSchema,
	parseParams,
	stringArray,
	trimmedString,
} from "./param-codec";
import { blockedResult } from "./tool-result";

export const PLANNER_STUCK_TOOL_NAMES = ["planner_report_stuck"] as const;
export type PlannerStuckToolName = (typeof PLANNER_STUCK_TOOL_NAMES)[number];

export interface PlannerStuckToolExecutionResult {
	status: "applied" | "blocked";
	toolName: PlannerStuckToolName;
	text: string;
	details: PlannerStuckAttemptArtifacts | null;
}

export interface PlannerStuckAttemptArtifacts {
	attemptId: string;
	attemptDir: string;
	reportPath: string;
	diffPatchPath: string;
	diffStatPath: string;
	changedFilesPath: string;
}

export const PLANNER_STUCK_TYPES = [
	"test_failure",
	"build_failure",
	"type_error",
	"unknown_api",
	"flaky_behavior",
	"unclear_requirement",
	"missing_context",
	"bad_assumption",
	"implementation_loop",
] as const;
export type PlannerStuckType = (typeof PLANNER_STUCK_TYPES)[number];

interface PlannerStuckReportInput {
	stuckType: PlannerStuckType;
	observedError: string | null;
	evidence: string[];
	hypotheses: string[];
	discardedHypotheses: string[];
	stuckLoad: PlannerStuckLoadScore;
	nextProbe: string;
	needsUserInput: boolean;
}

interface PlannerStuckLoadScore {
	failedAttempts: number;
	evidenceQuality: number;
	hypothesisChurn: number;
	contextDrift: number;
	verificationGap: number;
	total: number;
	level: "low" | "medium" | "high" | "critical";
}

export async function executePlannerStuckTool(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerStuckToolName;
	params: unknown;
	now?: number;
}): Promise<PlannerStuckToolExecutionResult> {
	const orchestrator = await runPlannerOrchestrator(input);
	if (orchestrator.preflight.context.status !== "ready") {
		return blocked(input.toolName, orchestrator.preflight.context.reason);
	}
	const policy = checkPlannerOrchestratorToolAllowed({
		orchestrator,
		toolName: input.toolName,
	});
	if (!policy.allow) {
		return blocked(
			input.toolName,
			policy.reason ?? `Planner stuck tool ${input.toolName} is blocked.`,
		);
	}

	const { state, planPaths } = orchestrator.preflight.context;
	if (state.stage !== "execution" || state.stepStatus !== "running") {
		return blocked(
			input.toolName,
			"planner_report_stuck is allowed only while an execution step is running.",
		);
	}
	if (!state.activeTaskId) {
		return blocked(
			input.toolName,
			"planner_report_stuck requires an active task id.",
		);
	}
	if (!state.worktreePath) {
		return blocked(input.toolName, "planner_report_stuck requires a worktree.");
	}

	const parsed = parseStuckReportParams(input.params);
	if (!parsed.ok) {
		return blocked(input.toolName, parsed.error);
	}
	const report = parsed.value;
	const timestamp = input.now ?? Date.now();
	const artifacts = await writeStuckAttemptArtifacts({
		fs: input.fs,
		git: input.git,
		repoRoot: state.worktreePath,
		taskDir: join(planPaths.tasksDir, state.activeTaskId),
		stage: state.stage,
		step: state.step,
		report,
		timestamp,
	});
	const debugSession = await initializePlannerDebugSession({
		fs: input.fs,
		state,
		planPaths,
		taskId: state.activeTaskId,
		attemptId: artifacts.attemptId,
	});

	await updatePlanState(input.fs, planPaths, (current) => ({
		...current,
		lastStuckReportPath: artifacts.reportPath,
		lastStuckAttemptId: artifacts.attemptId,
		...debugSession.statePatch,
		idleWakeInFlight: false,
		blockedReason: `Stuck attempt recorded: ${artifacts.reportPath}`,
	}));

	return {
		status: "applied",
		toolName: input.toolName,
		text: [
			`Planner stuck attempt recorded: ${artifacts.attemptId}.`,
			`Report: ${artifacts.reportPath}`,
			`Full diff: ${artifacts.diffPatchPath}`,
			`Diff stat: ${artifacts.diffStatPath}`,
			`Debug artifacts dir: ${debugSession.debugArtifactsDir}`,
			`Stuck load: ${report.stuckLoad.total}/15 (${report.stuckLoad.level})`,
			"",
			"Next action is planner-controlled compact. After compaction, call planner_status first, then read stuck.md and diff_stat.md.",
			"Reset the working tone: this is not a failure state; it means the previous approach is under-instrumented.",
			"Choose exactly one next probe from the report, run a focused command or inspect a focused file, and update the implementation from that evidence.",
			"Do not repeat the previous attempt unless new evidence proves it was correct. If needsUserInput is true, stop and ask the user after planner_status.",
		].join("\n"),
		details: artifacts,
	};
}

export async function buildPlannerStuckCompactInstructions(input: {
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
}): Promise<string | null> {
	const context = await readActivePlanContext({
		fs: input.fs,
		projectPaths: input.projectPaths,
	});
	if (context.status !== "ready") return null;
	const { state, activePlanId } = context;
	return [
		"[PI-CODE-PLANNER STUCK COMPACT INSTRUCTIONS]",
		"",
		"Create a concise compact summary for a stuck execution attempt.",
		"Do not replay the failed implementation in prose. Preserve paths and decisions.",
		"After compaction, the next message must call planner_status before any other tool.",
		"The model must inspect stuck.md and diff_stat.md before continuing. It may open the full diff patch only when specific changed lines are needed.",
		"Reset the working tone after compact: avoid carrying forward helpless or repetitive language. Treat the report as evidence for the next probe, not as proof that the task is impossible.",
		"Use this recovery rule: one hypothesis, one smallest falsifying probe, one observed fact, then patch only from evidence.",
		"Continue with one focused probe from the stuck report. Do not repeat the previous attempt without new evidence.",
		"If the report says needsUserInput is true, ask the user a concrete question instead of guessing.",
		"",
		"## Planner State",
		`- planId: ${activePlanId}`,
		`- stage: ${state.stage}`,
		`- step: ${state.step}`,
		`- stepStatus: ${state.stepStatus}`,
		`- activeTaskId: ${state.activeTaskId ?? "(none)"}`,
		`- lastStuckAttemptId: ${state.lastStuckAttemptId ?? "(none)"}`,
		`- lastStuckReportPath: ${state.lastStuckReportPath ?? "(none)"}`,
	].join("\n");
}

async function writeStuckAttemptArtifacts(input: {
	fs: PlannerFs;
	git: GitRunner;
	repoRoot: string;
	taskDir: string;
	stage: string;
	step: string;
	report: PlannerStuckReportInput;
	timestamp: number;
}): Promise<PlannerStuckAttemptArtifacts> {
	const attemptId = await nextAttemptId(
		input.fs,
		join(input.taskDir, "attempts"),
	);
	const attemptDir = join(input.taskDir, "attempts", attemptId);
	const diffPatchPath = join(attemptDir, "diff.patch");
	const diffStatPath = join(attemptDir, "diff_stat.md");
	const changedFilesPath = join(attemptDir, "changed_files.txt");
	const reportPath = join(attemptDir, "stuck.md");
	const [diffPatch, diffStat, changedFiles] = await Promise.all([
		readDiffPatch(input.git, input.repoRoot),
		input.git.diffStat({ repoRoot: input.repoRoot }),
		input.git.diffNameOnly({ repoRoot: input.repoRoot }),
	]);

	await input.fs.mkdirp(attemptDir);
	await input.fs.writeTextAtomic(
		diffPatchPath,
		diffPatch || "(no uncommitted diff)\n",
	);
	await input.fs.writeTextAtomic(diffStatPath, diffStat || "(no diff stat)\n");
	await input.fs.writeTextAtomic(
		changedFilesPath,
		changedFiles || "(no changed files)\n",
	);
	await input.fs.writeTextAtomic(
		reportPath,
		[
			`# ${attemptId}`,
			"",
			`- recordedAt: ${new Date(input.timestamp).toISOString()}`,
			`- stage: ${input.stage}`,
			`- step: ${input.step}`,
			`- stuckType: ${input.report.stuckType}`,
			`- needsUserInput: ${String(input.report.needsUserInput)}`,
			`- observedError: ${input.report.observedError ?? "(none)"}`,
			`- stuckLoadTotal: ${input.report.stuckLoad.total}`,
			`- stuckLoadLevel: ${input.report.stuckLoad.level}`,
			"",
			"## Stuck Load",
			`- failedAttempts: ${input.report.stuckLoad.failedAttempts}`,
			`- evidenceQuality: ${input.report.stuckLoad.evidenceQuality}`,
			`- hypothesisChurn: ${input.report.stuckLoad.hypothesisChurn}`,
			`- contextDrift: ${input.report.stuckLoad.contextDrift}`,
			`- verificationGap: ${input.report.stuckLoad.verificationGap}`,
			"",
			"## Recovery Reset",
			"This attempt is under-instrumented, not hopeless. Continue from persisted evidence only: reread planner_status, stuck.md, diff_stat.md, then run one smallest falsifying probe.",
			"",
			"## Evidence",
			formatList(input.report.evidence),
			"",
			"## Hypotheses",
			formatList(input.report.hypotheses),
			"",
			"## Discarded Hypotheses",
			formatList(input.report.discardedHypotheses),
			"",
			"## Next Probe",
			input.report.nextProbe,
			"",
			"## Artifact Links",
			`- fullDiff: ${diffPatchPath}`,
			`- diffStat: ${diffStatPath}`,
			`- changedFiles: ${changedFilesPath}`,
		].join("\n"),
	);

	return {
		attemptId,
		attemptDir,
		reportPath,
		diffPatchPath,
		diffStatPath,
		changedFilesPath,
	};
}

async function nextAttemptId(
	fs: PlannerFs,
	attemptsDir: string,
): Promise<string> {
	const entries = (await safeReaddir(fs, attemptsDir)).filter((entry) =>
		/^attempt-\d+$/.test(entry),
	);
	const next =
		entries.reduce((max, entry) => {
			const value = Number(entry.slice("attempt-".length));
			return Number.isFinite(value) ? Math.max(max, value) : max;
		}, 0) + 1;
	return `attempt-${String(next).padStart(3, "0")}`;
}

async function readDiffPatch(
	git: GitRunner,
	repoRoot: string,
): Promise<string> {
	return git.diffPatch({ repoRoot });
}

function blocked(toolName: PlannerStuckToolName, text: string) {
	return blockedResult(toolName, text);
}

const STUCK_LOAD_SCHEMA = {
	failedAttempts: intRange(0, 3),
	evidenceQuality: intRange(0, 3),
	hypothesisChurn: intRange(0, 3),
	contextDrift: intRange(0, 3),
	verificationGap: intRange(0, 3),
} satisfies ParamSchema;

const STUCK_REPORT_SCHEMA = {
	stuckType: enumOf(PLANNER_STUCK_TYPES),
	observedError: optionalString(),
	evidence: nonEmptyStringArray(),
	hypotheses: nonEmptyStringArray(),
	discardedHypotheses: stringArray(),
	stuckLoad: objectOf(STUCK_LOAD_SCHEMA),
	nextProbe: trimmedString(),
	needsUserInput: boolean(),
} satisfies ParamSchema;

function parseStuckReportParams(
	raw: unknown,
): { ok: true; value: PlannerStuckReportInput } | { ok: false; error: string } {
	const parsed = parseParams("planner_report_stuck", STUCK_REPORT_SCHEMA, raw);
	if (!parsed.ok) return parsed;
	return {
		ok: true,
		value: {
			...parsed.value,
			stuckLoad: scoreStuckLoad(parsed.value.stuckLoad),
		},
	};
}

function scoreStuckLoad(scores: {
	failedAttempts: number;
	evidenceQuality: number;
	hypothesisChurn: number;
	contextDrift: number;
	verificationGap: number;
}): PlannerStuckLoadScore {
	const total =
		scores.failedAttempts +
		scores.evidenceQuality +
		scores.hypothesisChurn +
		scores.contextDrift +
		scores.verificationGap;
	return {
		...scores,
		total,
		level:
			total <= 3
				? "low"
				: total <= 7
					? "medium"
					: total <= 11
						? "high"
						: "critical",
	};
}

function formatList(values: string[]): string {
	return values.length
		? values.map((value) => `- ${value}`).join("\n")
		: "- (none)";
}

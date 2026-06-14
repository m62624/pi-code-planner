import { join } from "node:path";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { updatePlanState } from "../storage/state-store";
import { readActivePlanContext } from "./active-plan";
import { initializePlannerDebugSession } from "./debug-tools";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";

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

	let report: PlannerStuckReportInput;
	try {
		report = parseStuckReportParams(asObject(input.params));
	} catch (error) {
		return blocked(input.toolName, errorMessage(error));
	}
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

async function safeReaddir(fs: PlannerFs, path: string): Promise<string[]> {
	try {
		return await fs.readdir(path);
	} catch {
		return [];
	}
}

async function readDiffPatch(
	git: GitRunner,
	repoRoot: string,
): Promise<string> {
	return git.diffPatch({ repoRoot });
}

function blocked(toolName: PlannerStuckToolName, text: string) {
	return { status: "blocked" as const, toolName, text, details: null };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function parseStuckReportParams(
	params: Record<string, unknown>,
): PlannerStuckReportInput {
	return {
		stuckType: requiredStuckType(params),
		observedError: optionalString(params, "observedError"),
		evidence: requiredStringArray(params.evidence, "evidence"),
		hypotheses: requiredStringArray(params.hypotheses, "hypotheses"),
		discardedHypotheses: stringArray(
			params.discardedHypotheses,
			"discardedHypotheses",
		),
		stuckLoad: requiredStuckLoad(params.stuckLoad),
		nextProbe: requiredString(params, "nextProbe"),
		needsUserInput: requiredBoolean(params, "needsUserInput"),
	};
}

function requiredStuckLoad(value: unknown): PlannerStuckLoadScore {
	const object = asObject(value);
	const score = {
		failedAttempts: requiredScore(object, "failedAttempts"),
		evidenceQuality: requiredScore(object, "evidenceQuality"),
		hypothesisChurn: requiredScore(object, "hypothesisChurn"),
		contextDrift: requiredScore(object, "contextDrift"),
		verificationGap: requiredScore(object, "verificationGap"),
	};
	const total =
		score.failedAttempts +
		score.evidenceQuality +
		score.hypothesisChurn +
		score.contextDrift +
		score.verificationGap;
	return {
		...score,
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

function requiredScore(params: Record<string, unknown>, key: string): number {
	const value = params[key];
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 0 ||
		value > 3
	) {
		throw new TypeError(`${key} must be an integer from 0 to 3.`);
	}
	return value;
}

function requiredStuckType(params: Record<string, unknown>): PlannerStuckType {
	const value = params.stuckType;
	if (!PLANNER_STUCK_TYPES.includes(value as PlannerStuckType)) {
		throw new TypeError(
			`stuckType must be one of: ${PLANNER_STUCK_TYPES.join(", ")}.`,
		);
	}
	return value as PlannerStuckType;
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value.trim();
}

function requiredBoolean(
	params: Record<string, unknown>,
	key: string,
): boolean {
	const value = params[key];
	if (typeof value !== "boolean") {
		throw new TypeError(`${key} must be a boolean.`);
	}
	return value;
}

function requiredStringArray(value: unknown, key: string): string[] {
	const result = stringArray(value, key);
	if (result.length === 0) {
		throw new TypeError(`${key} must contain at least one non-empty string.`);
	}
	return result;
}

function stringArray(value: unknown, key: string): string[] {
	if (!Array.isArray(value)) {
		throw new TypeError(`${key} must be a string array.`);
	}
	const result = value.map((entry) => {
		if (typeof entry !== "string") {
			throw new TypeError(`${key} must be a string array.`);
		}
		return entry.trim();
	});
	return result.filter((entry) => entry.length > 0);
}

function optionalString(
	params: Record<string, unknown>,
	key: string,
): string | null {
	const value = params[key];
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new TypeError(`${key} must be a string when provided.`);
	}
	return value.trim() || null;
}

function formatList(values: string[]): string {
	return values.length
		? values.map((value) => `- ${value}`).join("\n")
		: "- (none)";
}

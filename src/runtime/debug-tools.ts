import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { GitRunner } from "../git/runner";
import type { PlannerWrapperTool } from "../guard/tool-policy";
import type { PlannerFs } from "../storage/fs";
import type { PlanStoragePaths, ProjectStoragePaths } from "../storage/paths";
import type { PlanStateRecord } from "../storage/schema";
import { updatePlanState } from "../storage/state-store";
import {
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./orchestrator";
import { asObject } from "./values";

export const PLANNER_DEBUG_TOOL_NAMES = [
	"planner_debug_strategy",
	"planner_debug_probe",
	"planner_debug_result",
	"planner_debug_cleanup",
] as const satisfies readonly PlannerWrapperTool[];
export type PlannerDebugToolName = (typeof PLANNER_DEBUG_TOOL_NAMES)[number];

export const DEBUG_PROBE_METHODS = [
	"inspect_file",
	"run_command",
	"add_temp_log",
	"add_temp_assertion",
	"add_minimal_test",
	"inspect_diff",
	"ask_user",
] as const;
export type DebugProbeMethod = (typeof DEBUG_PROBE_METHODS)[number];

export const DEBUG_INSTRUMENTATION_TYPES = [
	"none",
	"stdout",
	"stderr",
	"temp_file",
	"framework_logger",
	"test_assertion",
] as const;
export type DebugInstrumentationType =
	(typeof DEBUG_INSTRUMENTATION_TYPES)[number];

export const DEBUG_RESULT_NEXT_ACTIONS = [
	"patch",
	"probe_again",
	"ask_user",
	"block",
] as const;
export type DebugResultNextAction = (typeof DEBUG_RESULT_NEXT_ACTIONS)[number];

export interface PlannerDebugToolExecutionResult {
	status: "applied" | "blocked";
	toolName: PlannerDebugToolName;
	text: string;
	details: unknown;
}

export async function initializePlannerDebugSession(input: {
	fs: PlannerFs;
	state: PlanStateRecord;
	planPaths: { tasksDir: string };
	taskId: string;
	attemptId: string;
}): Promise<{
	debugSessionId: string;
	debugArtifactsDir: string;
	statePatch: Pick<
		PlanStateRecord,
		| "debugSessionId"
		| "debugArtifactsDir"
		| "debugStrategyPath"
		| "activeDebugProbeId"
		| "debugCleanupRequired"
	>;
}> {
	const worktreePath = requireWorktreePath(input.state);
	const debugSessionId = `${input.attemptId}-${randomUUID().slice(0, 8)}`;
	const debugArtifactsDir = join(
		worktreePath,
		".pi",
		"pi-code-planner",
		"debug",
		safePathPart(input.taskId),
		debugSessionId,
	);
	await input.fs.mkdirp(debugArtifactsDir);
	await input.fs.writeTextAtomic(
		join(debugArtifactsDir, "README.md"),
		[
			"# Planner Debug Artifacts",
			"",
			"This directory was created after planner_report_stuck.",
			"Do not commit while this directory exists.",
			"Use planner_debug_cleanup after the needed signal is collected and temporary instrumentation is removed.",
			"",
			`- taskId: ${input.taskId}`,
			`- stuckAttemptId: ${input.attemptId}`,
			`- taskArtifactDir: ${join(input.planPaths.tasksDir, input.taskId)}`,
			"",
		].join("\n"),
	);
	return {
		debugSessionId,
		debugArtifactsDir,
		statePatch: {
			debugSessionId,
			debugArtifactsDir,
			debugStrategyPath: null,
			activeDebugProbeId: null,
			debugCleanupRequired: true,
		},
	};
}

export async function executePlannerDebugTool(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerDebugToolName;
	params: unknown;
}): Promise<PlannerDebugToolExecutionResult> {
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
			policy.reason ?? `Planner debug tool ${input.toolName} is blocked.`,
		);
	}
	const context = orchestrator.preflight.context;
	const state = context.state;
	if (input.toolName !== "planner_debug_cleanup") {
		const gate = requireActiveDebugSession(state);
		if (gate) return blocked(input.toolName, gate);
	}

	switch (input.toolName) {
		case "planner_debug_strategy":
			return await writeDebugStrategy(input, context.planPaths, state);
		case "planner_debug_probe":
			return await writeDebugProbe(input, context.planPaths, state);
		case "planner_debug_result":
			return await writeDebugResult(input, context.planPaths, state);
		case "planner_debug_cleanup":
			return await cleanupDebugArtifacts(input, context.planPaths, state);
	}
}

export async function assertNoPlannerDebugArtifactsBeforeCommit(input: {
	fs: PlannerFs;
	state: PlanStateRecord;
}): Promise<void> {
	const dir = input.state.debugArtifactsDir;
	if (!dir) return;
	if (!(await input.fs.exists(dir))) {
		return;
	}
	const entries = await safeReaddir(input.fs, dir);
	if (entries.length === 0 && !input.state.debugCleanupRequired) {
		return;
	}
	throw new Error(
		[
			"Planner git commit is blocked because planner debug artifacts still exist.",
			`Debug artifacts: ${dir}`,
			"Use planner_debug_cleanup after removing temporary project instrumentation/log files, then retry planner_git_commit.",
		].join("\n"),
	);
}

export function formatDebugStatusLines(state: PlanStateRecord): string[] {
	if (!state.debugArtifactsDir && !state.lastStuckAttemptId) {
		return ["- debugMode: inactive"];
	}
	return [
		`- debugMode: ${state.debugArtifactsDir ? "active" : "stuck-without-artifacts"}`,
		`- debugSessionId: ${state.debugSessionId ?? "(none)"}`,
		`- debugArtifactsDir: ${state.debugArtifactsDir ?? "(none)"}`,
		`- debugStrategyPath: ${state.debugStrategyPath ?? "(none)"}`,
		`- activeDebugProbeId: ${state.activeDebugProbeId ?? "(none)"}`,
		`- debugCleanupRequired: ${String(state.debugCleanupRequired)}`,
		...(state.debugArtifactsDir
			? [
					"- commitGuard: planner_git_commit is blocked until planner_debug_cleanup removes the debug artifacts directory.",
				]
			: []),
	];
}

async function writeDebugStrategy(
	input: {
		fs: PlannerFs;
		projectPaths: ProjectStoragePaths;
		toolName: PlannerDebugToolName;
		params: unknown;
	},
	planPaths: PlanStoragePaths,
	state: PlanStateRecord,
): Promise<PlannerDebugToolExecutionResult> {
	const dir = requireDebugArtifactsDir(state);
	const params = asObject(input.params);
	const path = join(dir, "strategy.md");
	const content = [
		"# Debug Strategy",
		"",
		`- runtimeTarget: ${requiredString(params, "runtimeTarget")}`,
		"",
		"## Available Signals",
		formatList(
			requiredStringArray(params.availableSignals, "availableSignals"),
		),
		"",
		"## Safe Instrumentation",
		formatList(
			requiredStringArray(params.safeInstrumentation, "safeInstrumentation"),
		),
		"",
		"## Forbidden Instrumentation",
		formatList(
			requiredStringArray(
				params.forbiddenInstrumentation,
				"forbiddenInstrumentation",
			),
		),
		"",
		"## Cleanup Plan",
		requiredString(params, "cleanupPlan"),
		"",
	].join("\n");
	await input.fs.writeTextAtomic(path, content);
	await updatePlanState(input.fs, planPaths, (current) => ({
		...current,
		debugStrategyPath: path,
		debugCleanupRequired: true,
	}));
	return applied(
		input.toolName,
		[
			"Planner debug strategy recorded.",
			`Strategy: ${path}`,
			"Next: call planner_debug_probe for exactly one focused signal before patching.",
		],
		{ path },
	);
}

async function writeDebugProbe(
	input: {
		fs: PlannerFs;
		projectPaths: ProjectStoragePaths;
		toolName: PlannerDebugToolName;
		params: unknown;
	},
	planPaths: PlanStoragePaths,
	state: PlanStateRecord,
): Promise<PlannerDebugToolExecutionResult> {
	if (!state.debugStrategyPath) {
		return blocked(
			input.toolName,
			"planner_debug_strategy must be called before planner_debug_probe to define the debugging approach.",
		);
	}
	if (state.activeDebugProbeId) {
		return blocked(
			input.toolName,
			`planner_debug_result must be called before opening a new probe. Active probe: ${state.activeDebugProbeId}.`,
		);
	}
	const dir = requireDebugArtifactsDir(state);
	const params = asObject(input.params);
	const method = requiredEnum(
		params,
		"method",
		DEBUG_PROBE_METHODS,
		"debug probe method",
	);
	const instrumentation = requiredEnum(
		params,
		"instrumentation",
		DEBUG_INSTRUMENTATION_TYPES,
		"debug instrumentation",
	);
	const probeId = `probe-${randomUUID().slice(0, 8)}`;
	const probeDir = join(dir, "probes", probeId);
	const tempOutputPath =
		instrumentation === "temp_file" || method === "add_temp_log"
			? join(probeDir, "temp-output.log")
			: null;
	await input.fs.mkdirp(probeDir);
	if (tempOutputPath) {
		await input.fs.writeTextAtomic(
			tempOutputPath,
			[
				"# Temporary planner debug output",
				"Write only temporary diagnostic output here.",
				"planner_git_commit is blocked until planner_debug_cleanup removes this file.",
				"",
			].join("\n"),
		);
	}
	const path = join(probeDir, "probe.md");
	const cleanupRequired =
		requiredBoolean(params, "cleanupRequired") ||
		tempOutputPath !== null ||
		method === "add_temp_assertion" ||
		method === "add_minimal_test" ||
		instrumentation !== "none";
	await input.fs.writeTextAtomic(
		path,
		[
			`# ${probeId}`,
			"",
			`- method: ${method}`,
			`- instrumentation: ${instrumentation}`,
			`- cleanupRequired: ${String(cleanupRequired)}`,
			`- tempOutputPath: ${tempOutputPath ?? "(none)"}`,
			"",
			"## Question",
			requiredString(params, "question"),
			"",
			"## Hypothesis",
			requiredString(params, "hypothesis"),
			"",
			"## Target",
			requiredString(params, "target"),
			"",
			"## Expected Signal",
			requiredString(params, "expectedSignal"),
			"",
		].join("\n"),
	);
	await updatePlanState(input.fs, planPaths, (current) => ({
		...current,
		activeDebugProbeId: probeId,
		debugCleanupRequired: true,
	}));
	return applied(
		input.toolName,
		[
			"Planner debug probe recorded.",
			`Probe: ${path}`,
			`Temp output path: ${tempOutputPath ?? "(none)"}`,
			"Run exactly this probe now. After observing the signal, call planner_debug_result before patching.",
		],
		{ probeId, path, tempOutputPath },
	);
}

async function writeDebugResult(
	input: {
		fs: PlannerFs;
		projectPaths: ProjectStoragePaths;
		toolName: PlannerDebugToolName;
		params: unknown;
	},
	planPaths: PlanStoragePaths,
	state: PlanStateRecord,
): Promise<PlannerDebugToolExecutionResult> {
	const dir = requireDebugArtifactsDir(state);
	const params = asObject(input.params);
	const nextAction = requiredEnum(
		params,
		"nextAction",
		DEBUG_RESULT_NEXT_ACTIONS,
		"debug result next action",
	);
	const probeId = optionalString(params, "probeId") ?? state.activeDebugProbeId;
	if (!probeId) {
		return blocked(
			input.toolName,
			"planner_debug_result requires an active probe or explicit probeId.",
		);
	}
	const resultId = `result-${randomUUID().slice(0, 8)}`;
	const path = join(dir, "probes", safePathPart(probeId), `${resultId}.md`);
	await input.fs.writeTextAtomic(
		path,
		[
			`# ${resultId}`,
			"",
			`- probeId: ${probeId}`,
			`- signalMatched: ${String(requiredBoolean(params, "signalMatched"))}`,
			`- cleanupDone: ${String(requiredBoolean(params, "cleanupDone"))}`,
			`- nextAction: ${nextAction}`,
			"",
			"## Observed Signal",
			requiredString(params, "observedSignal"),
			"",
			"## Conclusion",
			requiredString(params, "conclusion"),
			"",
		].join("\n"),
	);
	await updatePlanState(input.fs, planPaths, (current) => ({
		...current,
		activeDebugProbeId: null,
		debugCleanupRequired: true,
	}));
	const next =
		nextAction === "patch"
			? "Patch only from this observed signal. Before committing, remove temporary instrumentation/log files and call planner_debug_cleanup."
			: nextAction === "probe_again"
				? "Call planner_debug_probe with a different focused signal."
				: nextAction === "ask_user"
					? "Ask the user one concrete question grounded in the observed signal."
					: "Call planner_block_step or planner_report_stuck with the new evidence.";
	return applied(
		input.toolName,
		["Planner debug result recorded.", `Result: ${path}`, next],
		{ resultId, path, nextAction },
	);
}

async function cleanupDebugArtifacts(
	input: {
		fs: PlannerFs;
		projectPaths: ProjectStoragePaths;
		toolName: PlannerDebugToolName;
		params: unknown;
	},
	planPaths: PlanStoragePaths,
	state: PlanStateRecord,
): Promise<PlannerDebugToolExecutionResult> {
	const dir = state.debugArtifactsDir;
	if (!dir) {
		return blocked(input.toolName, "No planner debug artifacts are active.");
	}
	await input.fs.removeDir(dir);
	await updatePlanState(input.fs, planPaths, (current) => ({
		...current,
		debugSessionId: null,
		debugArtifactsDir: null,
		debugStrategyPath: null,
		activeDebugProbeId: null,
		debugCleanupRequired: false,
	}));
	return applied(
		input.toolName,
		[
			"Planner debug artifacts removed.",
			`Removed: ${dir}`,
			"planner_git_commit may proceed if the worktree is otherwise clean and no temporary instrumentation remains.",
		],
		{ removed: dir },
	);
}

function requireActiveDebugSession(state: PlanStateRecord): string | null {
	if (state.stage !== "execution" || state.stepStatus !== "running") {
		return "Planner debug tools are allowed only while an execution step is running.";
	}
	if (!state.lastStuckAttemptId) {
		return "Planner debug tools are available only after planner_report_stuck creates a stuck attempt.";
	}
	if (!state.debugArtifactsDir) {
		return "Planner debug artifacts directory is missing. Call planner_report_stuck first.";
	}
	return null;
}

function requireDebugArtifactsDir(state: PlanStateRecord): string {
	const gate = requireActiveDebugSession(state);
	if (gate || !state.debugArtifactsDir) {
		throw new Error(gate ?? "Planner debug artifacts directory is missing.");
	}
	return state.debugArtifactsDir;
}

function requireWorktreePath(state: PlanStateRecord): string {
	if (!state.worktreePath) {
		throw new Error("Planner debug session requires a worktree path.");
	}
	return state.worktreePath;
}

function applied(
	toolName: PlannerDebugToolName,
	lines: string[],
	details: unknown,
): PlannerDebugToolExecutionResult {
	return { status: "applied", toolName, text: lines.join("\n"), details };
}

function blocked(
	toolName: PlannerDebugToolName,
	text: string,
): PlannerDebugToolExecutionResult {
	return { status: "blocked", toolName, text, details: null };
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value.trim();
}

function optionalString(
	params: Record<string, unknown>,
	key: string,
): string | null {
	const value = params[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
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
	if (!Array.isArray(value)) {
		throw new TypeError(`${key} must be a string array.`);
	}
	const entries = value.map((entry) => {
		if (typeof entry !== "string") {
			throw new TypeError(`${key} must be a string array.`);
		}
		return entry.trim();
	});
	const result = entries.filter((entry) => entry.length > 0);
	if (result.length === 0) {
		throw new TypeError(`${key} must contain at least one non-empty string.`);
	}
	return result;
}

function requiredEnum<T extends readonly string[]>(
	params: Record<string, unknown>,
	key: string,
	values: T,
	label: string,
): T[number] {
	const value = params[key];
	if (!values.includes(value as T[number])) {
		throw new TypeError(
			`${key} must be a valid ${label}: ${values.join(", ")}.`,
		);
	}
	return value as T[number];
}

function formatList(values: string[]): string {
	return values.map((value) => `- ${value}`).join("\n");
}

async function safeReaddir(fs: PlannerFs, path: string): Promise<string[]> {
	try {
		return await fs.readdir(path);
	} catch {
		return [];
	}
}

function safePathPart(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80);
}

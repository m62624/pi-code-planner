import { join } from "node:path";
import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import { updatePlanState } from "../storage/state-store";
import { readActivePlanContext } from "./active-plan";
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

	const params = asObject(input.params);
	const reason = requiredString(params, "reason");
	const observedError = optionalString(params, "observedError");
	const lastAttempt = requiredString(params, "lastAttempt");
	const nextDebugPlan = requiredString(params, "nextDebugPlan");
	const timestamp = input.now ?? Date.now();
	const artifacts = await writeStuckAttemptArtifacts({
		fs: input.fs,
		git: input.git,
		repoRoot: state.worktreePath,
		taskDir: join(planPaths.tasksDir, state.activeTaskId),
		stage: state.stage,
		step: state.step,
		reason,
		observedError,
		lastAttempt,
		nextDebugPlan,
		timestamp,
	});

	await updatePlanState(input.fs, planPaths, (current) => ({
		...current,
		lastStuckReportPath: artifacts.reportPath,
		lastStuckAttemptId: artifacts.attemptId,
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
			"Next: compact will clear volatile context. After compaction, call planner_status, read the stuck report and diff stat, then continue with a different debugging plan.",
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
		"The model must inspect the stuck report and diff stat before continuing. It may open the full diff patch only when specific changed lines are needed.",
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
	reason: string;
	observedError: string | null;
	lastAttempt: string;
	nextDebugPlan: string;
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
			`- reason: ${input.reason}`,
			`- observedError: ${input.observedError ?? "(none)"}`,
			"",
			"## Last Attempt",
			input.lastAttempt,
			"",
			"## Next Debug Plan",
			input.nextDebugPlan,
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
	const maybe = git as GitRunner & {
		diffPatch?: (input: { repoRoot: string }) => Promise<string>;
	};
	return maybe.diffPatch ? await maybe.diffPatch({ repoRoot }) : "";
}

function blocked(toolName: PlannerStuckToolName, text: string) {
	return { status: "blocked" as const, toolName, text, details: null };
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || !value.trim()) {
		throw new TypeError(`${key} must be a non-empty string.`);
	}
	return value.trim();
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

import { withFileWriteLock } from "./file-lock";
import type { PlannerFs } from "./fs";
import { readJson, readJsonIfExists, writeJson } from "./json";
import type { PlanStoragePaths } from "./paths";
import type {
	PlannerContractsState,
	PlannerStage,
	PlannerStep,
	PlanStateRecord,
	StepStatus,
} from "./schema";
import { createDefaultPlannerContractsState } from "./schema";

export async function initializePlanState(
	fs: PlannerFs,
	paths: PlanStoragePaths,
	state: PlanStateRecord,
): Promise<PlanStateRecord> {
	await savePlanState(fs, paths, state);
	return state;
}

export async function readPlanState(
	fs: PlannerFs,
	paths: PlanStoragePaths,
): Promise<PlanStateRecord> {
	return normalizePlanState(
		await readJson<PlanStateRecord>(fs, paths.stateJson),
	);
}

export async function readPlanStateIfExists(
	fs: PlannerFs,
	paths: PlanStoragePaths,
): Promise<PlanStateRecord | null> {
	const state = await readJsonIfExists<PlanStateRecord>(fs, paths.stateJson);
	return state ? normalizePlanState(state) : null;
}

export async function savePlanState(
	fs: PlannerFs,
	paths: PlanStoragePaths,
	state: PlanStateRecord,
): Promise<void> {
	await withFileWriteLock(paths.stateJson, async () => {
		await writePlanStateUnlocked(fs, paths, state);
	});
}

async function writePlanStateUnlocked(
	fs: PlannerFs,
	paths: PlanStoragePaths,
	state: PlanStateRecord,
): Promise<void> {
	await fs.mkdirp(paths.planDir);
	await writeJson(fs, paths.stateJson, state);
}

export async function updatePlanState(
	fs: PlannerFs,
	paths: PlanStoragePaths,
	update: (state: PlanStateRecord) => PlanStateRecord,
): Promise<PlanStateRecord> {
	return await withFileWriteLock(paths.stateJson, async () => {
		const current = normalizePlanState(
			await readJson<PlanStateRecord>(fs, paths.stateJson),
		);
		const next = update(current);
		await writePlanStateUnlocked(fs, paths, next);
		return next;
	});
}

export async function setPlanStep(
	fs: PlannerFs,
	paths: PlanStoragePaths,
	input: {
		stage: PlannerStage;
		step: PlannerStep;
		stepStatus?: StepStatus;
		nextStep?: PlannerStep | null;
	},
): Promise<PlanStateRecord> {
	return await updatePlanState(fs, paths, (state) => ({
		...state,
		stage: input.stage,
		step: input.step,
		stepStatus: input.stepStatus ?? "pending",
		nextStep: input.nextStep ?? null,
		blockedReason: null,
	}));
}

export async function completePlanStep(
	fs: PlannerFs,
	paths: PlanStoragePaths,
	nextStep: PlannerStep | null,
): Promise<PlanStateRecord> {
	return await updatePlanState(fs, paths, (state) => ({
		...state,
		stepStatus: "completed",
		nextStep,
		blockedReason: null,
	}));
}

export async function markPlanBroken(
	fs: PlannerFs,
	paths: PlanStoragePaths,
	reason: string,
): Promise<PlanStateRecord> {
	return await updatePlanState(fs, paths, (state) => ({
		...state,
		stage: "recovery",
		step: "read_state",
		stepStatus: "blocked",
		nextStep: null,
		broken: true,
		brokenReason: reason,
		requiresUserDecision: true,
		blockedReason: reason,
	}));
}

/**
 * Assert a plan is in a worktree and return its path. An absent `worktreePath`
 * at a point that needs one is an internal invariant break (a should-never-happen
 * bug), so this throws; `message` lets a caller name its own context.
 */
export function requireWorktreePath(
	state: PlanStateRecord,
	message = "Plan state has no worktreePath.",
): string {
	if (!state.worktreePath) {
		throw new Error(message);
	}
	return state.worktreePath;
}

// Backward-compat shim for resuming plans created before a field existed.
// Adding a field to PlanStateRecord requires updating, together: this
// function's default, schema.ts's type, createInitialPlanState's default,
// and tests — skipping any one breaks resume for plans saved before the
// field was added (readJson returns the raw old object with the field
// missing).
// The removed window-management compact steps map to the real step that followed
// each in its old sequence. A persisted state.json parked at one (any stepStatus,
// including a mid-compaction `blocked` + requiresCompact) resumes cleanly at the
// successor with a fresh pending status — the boundary is moot now that the
// proactive monitor owns context pressure. compact_before_doubt is NOT here: it
// still exists as a live (forced) step.
const LEGACY_COMPACT_STEP_SUCCESSORS: Record<string, PlannerStep> = {
	compact_discovery: "enter_planning",
	compact_spec: "finish_spec",
	compact_planning: "enter_execution",
	compact_task: "select_next_task",
	compact_finalize: "enter_done",
};

function remapLegacyCompactStep(state: PlanStateRecord): PlanStateRecord {
	// The removed steps are no longer PlannerStep values, so match the raw string
	// a legacy state.json may still carry.
	const successor = LEGACY_COMPACT_STEP_SUCCESSORS[state.step as string];
	if (!successor) {
		return state;
	}
	return {
		...state,
		step: successor,
		stepStatus: "pending",
		nextStep: null,
		requiresCompact: false,
		blockedReason: null,
	};
}

function normalizePlanState(rawState: PlanStateRecord): PlanStateRecord {
	const state = remapLegacyCompactStep(rawState);
	return {
		...state,
		creationMethod: state.creationMethod ?? "create",
		compatibilityMode: state.compatibilityMode ?? "additive",
		worktreeBootstrapPending: state.worktreeBootstrapPending ?? false,
		questionsSubmitted: state.questionsSubmitted ?? false,
		questionsResolved: state.questionsResolved ?? false,
		compactBoundaries: state.compactBoundaries ?? {
			stage: true,
			task: false,
		},
		lastPlannerToolCallAt: state.lastPlannerToolCallAt ?? null,
		lastIdleWakeAt: state.lastIdleWakeAt ?? null,
		idleWakeInFlight: state.idleWakeInFlight ?? false,
		lastStuckReportPath: state.lastStuckReportPath ?? null,
		lastStuckAttemptId: state.lastStuckAttemptId ?? null,
		debugSessionId: state.debugSessionId ?? null,
		debugArtifactsDir: state.debugArtifactsDir ?? null,
		debugStrategyPath: state.debugStrategyPath ?? null,
		activeDebugProbeId: state.activeDebugProbeId ?? null,
		debugCleanupRequired: state.debugCleanupRequired ?? false,
		timer: state.timer ?? null,
		contracts: normalizePlannerContractsState(state.contracts),
		pendingFullStatus: state.pendingFullStatus ?? false,
		lastFullStatusStage: state.lastFullStatusStage ?? null,
		// Always reset on load — if Pi crashed mid-exec the process is already dead.
		execRunning: false,
	};
}

function normalizePlannerContractsState(
	value: PlannerContractsState | undefined,
): PlannerContractsState {
	const defaults = createDefaultPlannerContractsState();
	if (!value) {
		return defaults;
	}
	return {
		...defaults,
		...value,
		scanQueue: Array.isArray(value.scanQueue) ? value.scanQueue : [],
		discoveredPaths: Array.isArray(value.discoveredPaths)
			? value.discoveredPaths
			: [],
		childContracts:
			value.childContracts &&
			typeof value.childContracts === "object" &&
			!Array.isArray(value.childContracts)
				? Object.fromEntries(
						Object.entries(value.childContracts).map(([path, children]) => [
							path,
							Array.isArray(children)
								? children.filter((child) => typeof child === "string")
								: [],
						]),
					)
				: {},
		diagnostics: Array.isArray(value.diagnostics) ? value.diagnostics : [],
		activeChains: Array.isArray(value.activeChains) ? value.activeChains : [],
		summaries: Array.isArray(value.summaries) ? value.summaries : [],
		pendingRead: value.pendingRead ?? null,
		pendingCheckTaskId: value.pendingCheckTaskId ?? null,
		pendingUpsert: value.pendingUpsert ?? null,
		lastCheck: value.lastCheck ?? null,
		touchedFiles: Array.isArray(value.touchedFiles) ? value.touchedFiles : [],
	};
}

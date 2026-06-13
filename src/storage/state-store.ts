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

const stateWriteLocks = new Map<string, Promise<void>>();

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
	await withStateWriteLock(paths.stateJson, async () => {
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
	return await withStateWriteLock(paths.stateJson, async () => {
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

function normalizePlanState(state: PlanStateRecord): PlanStateRecord {
	return {
		...state,
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

async function withStateWriteLock<T>(
	stateJson: string,
	operation: () => Promise<T>,
): Promise<T> {
	const previous = stateWriteLocks.get(stateJson) ?? Promise.resolve();
	let release!: () => void;
	const current = new Promise<void>((resolve) => {
		release = resolve;
	});
	const queued = previous.then(() => current);
	stateWriteLocks.set(stateJson, queued);
	await previous;
	try {
		return await operation();
	} finally {
		release();
		if (stateWriteLocks.get(stateJson) === queued) {
			stateWriteLocks.delete(stateJson);
		}
	}
}

import type { PlannerFs } from "./fs";
import { readJson, readJsonIfExists, writeJson } from "./json";
import type { PlanStoragePaths } from "./paths";
import type {
	PlannerStage,
	PlannerStep,
	PlanStateRecord,
	StepStatus,
} from "./schema";

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
	return await readJson<PlanStateRecord>(fs, paths.stateJson);
}

export async function readPlanStateIfExists(
	fs: PlannerFs,
	paths: PlanStoragePaths,
): Promise<PlanStateRecord | null> {
	return await readJsonIfExists<PlanStateRecord>(fs, paths.stateJson);
}

export async function savePlanState(
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
	const current = await readPlanState(fs, paths);
	const next = update(current);
	await savePlanState(fs, paths, next);
	return next;
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

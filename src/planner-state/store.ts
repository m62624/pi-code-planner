import type { PlannerFs } from "../settings/fs";
import { writeJsonAtomic } from "../settings/fs";
import type { SettingsPaths } from "../settings/paths";
import {
	DEFAULT_PLANNER_RUNTIME_STATE,
	type PlannerGitState,
	type PlannerRuntimeState,
} from "./schema";

export interface PlannerStateInitResult {
	created: boolean;
	path: string;
	state: PlannerRuntimeState;
}

function cloneDefaultState(): PlannerRuntimeState {
	return structuredClone(DEFAULT_PLANNER_RUNTIME_STATE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNullableString(
	value: Record<string, unknown>,
	key: string,
): string | null {
	if (!Object.hasOwn(value, key)) {
		throw new Error(`Invalid planner state field: ${key}`);
	}
	const raw = value[key];
	if (raw === null) return null;
	if (typeof raw !== "string") {
		throw new Error(`Invalid planner state field: ${key}`);
	}
	return raw;
}

function parseGitState(value: unknown): PlannerGitState {
	if (!isRecord(value)) {
		throw new Error("Invalid planner state field: git");
	}

	return {
		baseBranch: readNullableString(value, "baseBranch"),
		planBranch: readNullableString(value, "planBranch"),
		expectedBranch: readNullableString(value, "expectedBranch"),
		expectedCommit: readNullableString(value, "expectedCommit"),
		lastObservedCommit: readNullableString(value, "lastObservedCommit"),
	};
}

export function parsePlannerRuntimeState(input: unknown): PlannerRuntimeState {
	if (!isRecord(input)) {
		throw new Error("Invalid planner state: expected object");
	}
	if (input.version !== 1) {
		throw new Error("Invalid planner state version");
	}

	return {
		version: 1,
		activePlanId: readNullableString(input, "activePlanId"),
		activeWorkItemId: readNullableString(input, "activeWorkItemId"),
		git: parseGitState(input.git),
	};
}

export function loadPlannerRuntimeState(
	paths: Pick<SettingsPaths, "globalDir" | "globalState">,
	fs: PlannerFs,
): PlannerRuntimeState {
	if (!fs.exists(paths.globalState)) {
		return initializePlannerRuntimeState(paths, fs).state;
	}

	return parsePlannerRuntimeState(JSON.parse(fs.readFile(paths.globalState)));
}

export function savePlannerRuntimeState(
	paths: Pick<SettingsPaths, "globalDir" | "globalState">,
	fs: PlannerFs,
	state: PlannerRuntimeState,
): void {
	writeJsonAtomic(fs, paths.globalState, parsePlannerRuntimeState(state));
}

export function initializePlannerRuntimeState(
	paths: Pick<SettingsPaths, "globalDir" | "globalState">,
	fs: PlannerFs,
): PlannerStateInitResult {
	fs.mkdirp(paths.globalDir);

	if (fs.exists(paths.globalState)) {
		return {
			created: false,
			path: paths.globalState,
			state: loadPlannerRuntimeState(paths, fs),
		};
	}

	const state = cloneDefaultState();
	writeJsonAtomic(fs, paths.globalState, state);
	return {
		created: true,
		path: paths.globalState,
		state,
	};
}

export function updatePlannerRuntimeState(
	paths: Pick<SettingsPaths, "globalDir" | "globalState">,
	fs: PlannerFs,
	update: (state: PlannerRuntimeState) => PlannerRuntimeState,
): PlannerRuntimeState {
	const next = update(loadPlannerRuntimeState(paths, fs));
	savePlannerRuntimeState(paths, fs, next);
	return next;
}

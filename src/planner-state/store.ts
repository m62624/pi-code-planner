import type { PlannerFs } from "../settings/fs";
import { writeJsonAtomic } from "../settings/fs";
import type { SettingsPaths } from "../settings/paths";
import {
	DEFAULT_PLANNER_RUNTIME_STATE,
	type PendingPlannerCompact,
	type PendingPlannerGitOperation,
	type PlannerBranchRecord,
	type PlannerBranchRegistry,
	type PlannerBranchStatus,
	type PlannerCompactReason,
	type PlannerCompactStatus,
	type PlannerGitState,
	type PlannerRuntimeMode,
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

function readOptionalNullableString(
	value: Record<string, unknown>,
	key: string,
): string | null {
	if (!Object.hasOwn(value, key)) return null;
	return readNullableString(value, key);
}

function readString(value: Record<string, unknown>, key: string): string {
	if (!Object.hasOwn(value, key) || typeof value[key] !== "string") {
		throw new Error(`Invalid planner state field: ${key}`);
	}
	return value[key];
}

function readBoolean(value: Record<string, unknown>, key: string): boolean {
	if (!Object.hasOwn(value, key) || typeof value[key] !== "boolean") {
		throw new Error(`Invalid planner state field: ${key}`);
	}
	return value[key];
}

function readEnum<T extends string>(
	value: Record<string, unknown>,
	key: string,
	allowed: readonly T[],
): T {
	const raw = readString(value, key);
	if (!allowed.includes(raw as T)) {
		throw new Error(`Invalid planner state field: ${key}`);
	}
	return raw as T;
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

const RUNTIME_MODES = [
	"idle",
	"plan_active",
	"operation_in_progress",
	"recovery_required",
] as const;

const GIT_OPERATION_TYPES = [
	"init",
	"create_branch",
	"switch_branch",
	"commit",
	"merge",
	"delete_branch",
	"soft_reset",
	"hard_reset",
] as const;

const COMPACT_REASONS = [
	"discovery",
	"work_item",
	"refactor",
	"manual",
] as const;

const COMPACT_STATUSES = ["requested", "completed", "failed"] as const;

const BRANCH_KINDS = ["base", "plan", "child", "experiment"] as const;

const BRANCH_STATUSES = [
	"active",
	"merged",
	"abandoned",
	"selected",
	"rejected",
	"deleted",
] as const;

function inferRuntimeMode(input: Record<string, unknown>): PlannerRuntimeMode {
	if (Object.hasOwn(input, "mode")) {
		return readEnum(input, "mode", RUNTIME_MODES);
	}
	return input.activePlanId === null ? "idle" : "plan_active";
}

function parseGitPosition(value: unknown, field: string) {
	if (!isRecord(value)) {
		throw new Error(`Invalid planner state field: ${field}`);
	}
	return {
		branch: readNullableString(value, "branch"),
		commit: readNullableString(value, "commit"),
	};
}

function parsePendingOperation(
	value: unknown,
): PendingPlannerGitOperation | null {
	if (value === undefined || value === null) return null;
	if (!isRecord(value)) {
		throw new Error("Invalid planner state field: pendingOperation");
	}

	return {
		id: readString(value, "id"),
		type: readEnum(value, "type", GIT_OPERATION_TYPES),
		startedAt: readString(value, "startedAt"),
		before: parseGitPosition(value.before, "before"),
		expectedAfter:
			value.expectedAfter === null
				? null
				: parseGitPosition(value.expectedAfter, "expectedAfter"),
	};
}

function parsePendingCompact(value: unknown): PendingPlannerCompact | null {
	if (value === undefined || value === null) return null;
	if (!isRecord(value)) {
		throw new Error("Invalid planner state field: pendingCompact");
	}

	return {
		id: readString(value, "id"),
		reason: readEnum(value, "reason", COMPACT_REASONS) as PlannerCompactReason,
		status: readEnum(value, "status", COMPACT_STATUSES) as PlannerCompactStatus,
		requestedAt: readString(value, "requestedAt"),
		completedAt: readNullableString(value, "completedAt"),
		failedAt: readNullableString(value, "failedAt"),
		error: readNullableString(value, "error"),
		activePlanId: readNullableString(value, "activePlanId"),
		activeWorkItemId: readNullableString(value, "activeWorkItemId"),
		customInstructions: readString(value, "customInstructions"),
		resumePrompt: readString(value, "resumePrompt"),
		attachToNextTurn: readBoolean(value, "attachToNextTurn"),
		autoResume: readBoolean(value, "autoResume"),
	};
}

function parseBranchRecord(value: unknown): PlannerBranchRecord {
	if (!isRecord(value)) {
		throw new Error("Invalid planner state branch record");
	}

	return {
		name: readString(value, "name"),
		kind: readEnum(value, "kind", BRANCH_KINDS),
		planId: readNullableString(value, "planId"),
		workItemId: readNullableString(value, "workItemId"),
		createdFromCommit: readNullableString(value, "createdFromCommit"),
		lastKnownCommit: readNullableString(value, "lastKnownCommit"),
		status: readEnum(value, "status", BRANCH_STATUSES) as PlannerBranchStatus,
	};
}

function defaultBranchRegistryFromGit(
	git: PlannerGitState,
): PlannerBranchRegistry {
	const items: Record<string, PlannerBranchRecord> = {};
	if (git.baseBranch) {
		items[git.baseBranch] = {
			name: git.baseBranch,
			kind: "base",
			planId: null,
			workItemId: null,
			createdFromCommit: null,
			lastKnownCommit: git.lastObservedCommit,
			status: "active",
		};
	}
	if (git.planBranch) {
		items[git.planBranch] = {
			name: git.planBranch,
			kind: "plan",
			planId: null,
			workItemId: null,
			createdFromCommit: git.lastObservedCommit,
			lastKnownCommit: git.lastObservedCommit,
			status: "active",
		};
	}
	return {
		baseBranch: git.baseBranch,
		planBranch: git.planBranch,
		items,
	};
}

function parseBranchRegistry(
	value: unknown,
	git: PlannerGitState,
): PlannerBranchRegistry {
	if (value === undefined) return defaultBranchRegistryFromGit(git);
	if (!isRecord(value)) {
		throw new Error("Invalid planner state field: branches");
	}
	if (!isRecord(value.items)) {
		throw new Error("Invalid planner state field: branches.items");
	}

	const items: Record<string, PlannerBranchRecord> = {};
	for (const [name, branch] of Object.entries(value.items)) {
		items[name] = parseBranchRecord(branch);
		if (items[name].name !== name) {
			throw new Error("Invalid planner state branch record name");
		}
	}

	return {
		baseBranch: readOptionalNullableString(value, "baseBranch"),
		planBranch: readOptionalNullableString(value, "planBranch"),
		items,
	};
}

export function parsePlannerRuntimeState(input: unknown): PlannerRuntimeState {
	if (!isRecord(input)) {
		throw new Error("Invalid planner state: expected object");
	}
	if (input.version !== 1) {
		throw new Error("Invalid planner state version");
	}
	const git = parseGitState(input.git);

	return {
		version: 1,
		mode: inferRuntimeMode(input),
		activePlanId: readNullableString(input, "activePlanId"),
		activeWorkItemId: readNullableString(input, "activeWorkItemId"),
		git,
		pendingOperation: parsePendingOperation(input.pendingOperation),
		pendingCompact: parsePendingCompact(input.pendingCompact),
		branches: parseBranchRegistry(input.branches, git),
	};
}

export function loadPlannerRuntimeState(
	paths: Pick<SettingsPaths, "projectDir" | "projectState">,
	fs: PlannerFs,
): PlannerRuntimeState {
	if (!fs.exists(paths.projectState)) {
		return initializePlannerRuntimeState(paths, fs).state;
	}

	return parsePlannerRuntimeState(JSON.parse(fs.readFile(paths.projectState)));
}

export function savePlannerRuntimeState(
	paths: Pick<SettingsPaths, "projectDir" | "projectState">,
	fs: PlannerFs,
	state: PlannerRuntimeState,
): void {
	writeJsonAtomic(fs, paths.projectState, parsePlannerRuntimeState(state));
}

export function initializePlannerRuntimeState(
	paths: Pick<SettingsPaths, "projectDir" | "projectState">,
	fs: PlannerFs,
): PlannerStateInitResult {
	fs.mkdirp(paths.projectState.replace("/state.json", ""));

	if (fs.exists(paths.projectState)) {
		return {
			created: false,
			path: paths.projectState,
			state: parsePlannerRuntimeState(
				JSON.parse(fs.readFile(paths.projectState)),
			),
		};
	}

	const state = cloneDefaultState();
	writeJsonAtomic(fs, paths.projectState, state);
	return {
		created: true,
		path: paths.projectState,
		state,
	};
}

export function updatePlannerRuntimeState(
	paths: Pick<SettingsPaths, "projectDir" | "projectState">,
	fs: PlannerFs,
	update: (state: PlannerRuntimeState) => PlannerRuntimeState,
): PlannerRuntimeState {
	const next = update(loadPlannerRuntimeState(paths, fs));
	savePlannerRuntimeState(paths, fs, next);
	return next;
}

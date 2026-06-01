import type { PlannerFs } from "../storage/fs";
import { readJson, readJsonIfExists, writeJson } from "../storage/json";
import type { ProjectStoragePaths } from "../storage/paths";
import { createPlannerSettingsPaths, type PlannerSettingsPaths } from "./paths";
import {
	DEFAULT_PLANNER_SETTINGS,
	type PlannerSettings,
	type PlannerSettingsFile,
	type WorktreeSettings,
} from "./schema";

export interface EffectivePlannerSettings {
	paths: PlannerSettingsPaths;
	global: PlannerSettingsFile;
	project: PlannerSettingsFile | null;
	effective: PlannerSettings;
	worktreeSource: "project" | "global" | "default";
	compactSource: "project" | "global" | "default";
}

export async function loadEffectivePlannerSettings(input: {
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
}): Promise<EffectivePlannerSettings> {
	const paths = createPlannerSettingsPaths(input.projectPaths);
	await ensureGlobalPlannerSettings(input.fs, paths);

	const global = normalizeSettingsFile(
		await readJson<unknown>(input.fs, paths.globalSettingsJson),
		paths.globalSettingsJson,
	);
	const projectRaw = await readJsonIfExists<unknown>(
		input.fs,
		paths.projectSettingsJson,
	);
	const project =
		projectRaw === null
			? null
			: normalizeSettingsFile(projectRaw, paths.projectSettingsJson);
	const worktreeSource = project?.worktree
		? "project"
		: global.worktree
			? "global"
			: "default";
	const worktree =
		project?.worktree ?? global.worktree ?? DEFAULT_PLANNER_SETTINGS.worktree;
	const compactSource = project?.compact
		? "project"
		: global.compact
			? "global"
			: "default";
	const compact = {
		...DEFAULT_PLANNER_SETTINGS.compact,
		...(global.compact ?? {}),
		...(project?.compact ?? {}),
	};

	return {
		paths,
		global,
		project,
		effective: { worktree, compact },
		worktreeSource,
		compactSource,
	};
}

export async function ensureGlobalPlannerSettings(
	fs: PlannerFs,
	paths: PlannerSettingsPaths,
): Promise<void> {
	if (await fs.exists(paths.globalSettingsJson)) {
		return;
	}
	await writeJson(fs, paths.globalSettingsJson, DEFAULT_PLANNER_SETTINGS);
}

function normalizeSettingsFile(
	value: unknown,
	path: string,
): PlannerSettingsFile {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`Planner settings must be an object: ${path}`);
	}
	const record = value as Record<string, unknown>;
	return {
		...(record.worktree === undefined
			? {}
			: { worktree: normalizeWorktreeSettings(record.worktree, path) }),
		...(record.compact === undefined
			? {}
			: { compact: normalizeCompactSettings(record.compact, path) }),
	};
}

function normalizeCompactSettings(
	value: unknown,
	path: string,
): PlannerSettingsFile["compact"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`Planner compact settings must be an object: ${path}`);
	}
	const record = value as Record<string, unknown>;
	for (const key of ["stage", "task", "experiment"] as const) {
		if (record[key] !== undefined && typeof record[key] !== "boolean") {
			throw new TypeError(
				`Planner compact setting ${key} must be boolean: ${path}`,
			);
		}
	}
	return {
		...(typeof record.stage === "boolean" ? { stage: record.stage } : {}),
		...(typeof record.task === "boolean" ? { task: record.task } : {}),
		...(typeof record.experiment === "boolean"
			? { experiment: record.experiment }
			: {}),
	};
}

function normalizeWorktreeSettings(
	value: unknown,
	path: string,
): WorktreeSettings {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`Planner worktree settings must be an object: ${path}`);
	}
	const record = value as Record<string, unknown>;
	if (record.mode === "project-local") {
		return { mode: "project-local" };
	}
	if (record.mode === "custom") {
		if (typeof record.root !== "string" || record.root.trim().length === 0) {
			throw new TypeError(
				`Planner custom worktree settings require a non-empty root: ${path}`,
			);
		}
		return { mode: "custom", root: record.root.trim() };
	}
	throw new TypeError(
		`Planner worktree mode must be "project-local" or "custom": ${path}`,
	);
}

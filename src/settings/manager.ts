import type { PlannerFs } from "../storage/fs";
import { readJson, readJsonIfExists, writeJson } from "../storage/json";
import type { ProjectStoragePaths } from "../storage/paths";
import { createPlannerSettingsPaths, type PlannerSettingsPaths } from "./paths";
import {
	DEFAULT_PLANNER_SETTINGS,
	type PlannerContractLevelBudgets,
	type PlannerSettings,
	type PlannerSettingsFile,
	type WorktreeSettings,
} from "./schema";

const DEFAULT_PLANNER_SETTINGS_FILE: PlannerSettingsFile = {
	worktree: DEFAULT_PLANNER_SETTINGS.worktree,
	compact: DEFAULT_PLANNER_SETTINGS.compact,
	idle: DEFAULT_PLANNER_SETTINGS.idle,
	metadata: {
		humanLanguage: DEFAULT_PLANNER_SETTINGS.metadata.humanLanguage,
	},
	timer: DEFAULT_PLANNER_SETTINGS.timer,
	skills: DEFAULT_PLANNER_SETTINGS.skills,
	contracts: DEFAULT_PLANNER_SETTINGS.contracts,
	workspace: DEFAULT_PLANNER_SETTINGS.workspace,
};

export interface EffectivePlannerSettings {
	paths: PlannerSettingsPaths;
	global: PlannerSettingsFile;
	project: PlannerSettingsFile | null;
	effective: PlannerSettings;
	worktreeSource: "project" | "global" | "default";
	compactSource: "project" | "global" | "default";
	idleSource: "project" | "global" | "default";
	execSource: "project" | "global" | "default";
	metadataSource: "project" | "global" | "default";
	timerSource: "project" | "global" | "default";
	skillsSource: "project" | "global" | "default";
	contractsSource: "project" | "global" | "default";
	workspaceSource: "project" | "global" | "default";
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
	// Unlike compact/idle/timer/skills/contracts/workspace below, `worktree` is
	// taken wholesale from whichever level wins — not merged field-by-field.
	// A project `worktree` block fully replaces global's, even if it only
	// needs to override one field.
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
	const idleSource = project?.idle
		? "project"
		: global.idle
			? "global"
			: "default";
	const idle = {
		...DEFAULT_PLANNER_SETTINGS.idle,
		...(global.idle ?? {}),
		...(project?.idle ?? {}),
	};
	const execSource = project?.exec
		? "project"
		: global.exec
			? "global"
			: "default";
	const exec = {
		...DEFAULT_PLANNER_SETTINGS.exec,
		...(global.exec ?? {}),
		...(project?.exec ?? {}),
	};
	const metadataSource = project?.metadata
		? "project"
		: global.metadata
			? "global"
			: "default";
	const metadata = mergeMetadataSettings(global.metadata, project?.metadata);
	const timerSource = project?.timer
		? "project"
		: global.timer
			? "global"
			: "default";
	const timer = {
		...DEFAULT_PLANNER_SETTINGS.timer,
		...(global.timer ?? {}),
		...(project?.timer ?? {}),
	};
	const skillsSource = project?.skills
		? "project"
		: global.skills
			? "global"
			: "default";
	const skills = {
		...DEFAULT_PLANNER_SETTINGS.skills,
		...(global.skills ?? {}),
		...(project?.skills ?? {}),
	};
	const contractsSource = project?.contracts
		? "project"
		: global.contracts
			? "global"
			: "default";
	const contracts = mergeContractsSettings(
		global.contracts,
		project?.contracts,
	);
	const workspaceSource = project?.workspace
		? "project"
		: global.workspace
			? "global"
			: "default";
	const workspace = {
		...DEFAULT_PLANNER_SETTINGS.workspace,
		...(global.workspace ?? {}),
		...(project?.workspace ?? {}),
	};

	return {
		paths,
		global,
		project,
		effective: {
			worktree,
			compact,
			idle,
			exec,
			metadata,
			timer,
			skills,
			contracts,
			workspace,
		},
		worktreeSource,
		compactSource,
		idleSource,
		execSource,
		metadataSource,
		timerSource,
		skillsSource,
		contractsSource,
		workspaceSource,
	};
}

export async function ensureGlobalPlannerSettings(
	fs: PlannerFs,
	paths: PlannerSettingsPaths,
): Promise<void> {
	if (await fs.exists(paths.globalSettingsJson)) {
		return;
	}
	await writeJson(fs, paths.globalSettingsJson, DEFAULT_PLANNER_SETTINGS_FILE);
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
		...(record.idle === undefined
			? {}
			: { idle: normalizeIdleSettings(record.idle, path) }),
		...(record.exec === undefined
			? {}
			: { exec: normalizeExecSettings(record.exec, path) }),
		...(record.metadata === undefined
			? {}
			: { metadata: normalizeMetadataSettings(record.metadata, path) }),
		...(record.timer === undefined
			? {}
			: { timer: normalizeTimerSettings(record.timer, path) }),
		...(record.skills === undefined
			? {}
			: { skills: normalizeSkillsSettings(record.skills, path) }),
		...(record.contracts === undefined
			? {}
			: { contracts: normalizeContractsSettings(record.contracts, path) }),
		...(record.workspace === undefined
			? {}
			: { workspace: normalizeWorkspaceSettings(record.workspace, path) }),
	};
}

function normalizeWorkspaceSettings(
	value: unknown,
	path: string,
): PlannerSettingsFile["workspace"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(
			`Planner workspace settings must be an object: ${path}`,
		);
	}
	const record = value as Record<string, unknown>;
	const result: NonNullable<PlannerSettingsFile["workspace"]> = {};
	if (record.enabled !== undefined) {
		if (typeof record.enabled !== "boolean") {
			throw new TypeError(
				`Planner workspace setting enabled must be boolean: ${path}`,
			);
		}
		result.enabled = record.enabled;
	}
	if (record.autoOpen !== undefined) {
		if (typeof record.autoOpen !== "boolean") {
			throw new TypeError(
				`Planner workspace setting autoOpen must be boolean: ${path}`,
			);
		}
		result.autoOpen = record.autoOpen;
	}
	if (record.footerReserveRows !== undefined) {
		if (
			typeof record.footerReserveRows !== "number" ||
			!Number.isInteger(record.footerReserveRows) ||
			record.footerReserveRows < 0 ||
			record.footerReserveRows > 20
		) {
			throw new TypeError(
				`Planner workspace setting footerReserveRows must be an integer from 0 to 20: ${path}`,
			);
		}
		result.footerReserveRows = record.footerReserveRows;
	}
	if (record.keys !== undefined) {
		result.keys = normalizeWorkspaceKeys(record.keys, path);
	}
	return result;
}

const WORKSPACE_ACTIONS = [
	"focusNext",
	"up",
	"down",
	"pageUp",
	"pageDown",
	"jumpBottom",
	"jumpTop",
	"expand",
	"submit",
	"exit",
] as const;

function normalizeWorkspaceKeys(
	value: unknown,
	path: string,
): NonNullable<PlannerSettingsFile["workspace"]>["keys"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`Planner workspace.keys must be an object: ${path}`);
	}
	const record = value as Record<string, unknown>;
	const result: Record<string, string[]> = {};
	for (const action of WORKSPACE_ACTIONS) {
		const keys = record[action];
		if (keys === undefined) continue;
		if (
			!Array.isArray(keys) ||
			keys.some((k) => typeof k !== "string" || k.trim().length === 0)
		) {
			throw new TypeError(
				`Planner workspace.keys.${action} must be a non-empty string array: ${path}`,
			);
		}
		result[action] = keys.map((k) => (k as string).trim());
	}
	return result;
}

function normalizeCompactSettings(
	value: unknown,
	path: string,
): PlannerSettingsFile["compact"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`Planner compact settings must be an object: ${path}`);
	}
	const record = value as Record<string, unknown>;
	for (const key of ["stage", "task"] as const) {
		if (record[key] !== undefined && typeof record[key] !== "boolean") {
			throw new TypeError(
				`Planner compact setting ${key} must be boolean: ${path}`,
			);
		}
	}
	return {
		...(typeof record.stage === "boolean" ? { stage: record.stage } : {}),
		...(typeof record.task === "boolean" ? { task: record.task } : {}),
	};
}

function normalizeExecSettings(
	value: unknown,
	path: string,
): PlannerSettingsFile["exec"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`Planner exec settings must be an object: ${path}`);
	}
	const record = value as Record<string, unknown>;
	return {
		...(record.defaultTimeoutSeconds === undefined
			? {}
			: {
					defaultTimeoutSeconds: positiveNumber(
						record.defaultTimeoutSeconds,
						"exec.defaultTimeoutSeconds",
						path,
					),
				}),
		...(record.maxTimeoutSeconds === undefined
			? {}
			: {
					maxTimeoutSeconds: positiveNumber(
						record.maxTimeoutSeconds,
						"exec.maxTimeoutSeconds",
						path,
					),
				}),
		...(record.maxOutputBytes === undefined
			? {}
			: {
					maxOutputBytes: positiveInteger(
						record.maxOutputBytes,
						"exec.maxOutputBytes",
						path,
					),
				}),
	};
}

function normalizeIdleSettings(
	value: unknown,
	path: string,
): PlannerSettingsFile["idle"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`Planner idle settings must be an object: ${path}`);
	}
	const record = value as Record<string, unknown>;
	if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
		throw new TypeError(
			`Planner idle setting enabled must be boolean: ${path}`,
		);
	}
	return {
		...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
		...(record.timeoutMinutes === undefined
			? {}
			: {
					timeoutMinutes: positiveNumber(
						record.timeoutMinutes,
						"timeoutMinutes",
						path,
					),
				}),
	};
}

function positiveNumber(value: unknown, key: string, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new TypeError(
			`Planner idle setting ${key} must be a positive number: ${path}`,
		);
	}
	return value;
}

function positiveInteger(value: unknown, key: string, path: string): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		!Number.isFinite(value) ||
		value <= 0
	) {
		throw new TypeError(
			`Planner setting ${key} must be a positive integer: ${path}`,
		);
	}
	return value;
}

function nonNegativeInteger(value: unknown, key: string, path: string): number {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		!Number.isFinite(value) ||
		value < 0
	) {
		throw new TypeError(
			`Planner setting ${key} must be a non-negative integer: ${path}`,
		);
	}
	return value;
}

function normalizeMetadataSettings(
	value: unknown,
	path: string,
): PlannerSettingsFile["metadata"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`Planner metadata settings must be an object: ${path}`);
	}
	const record = value as Record<string, unknown>;
	for (const key of [
		"humanLanguage",
		"titleLanguage",
		"descriptionLanguage",
		"commitLanguage",
		"doubtReviewLanguage",
		"skillLanguage",
	] as const) {
		if (
			record[key] !== undefined &&
			(typeof record[key] !== "string" || record[key].trim().length === 0)
		) {
			throw new TypeError(
				`Planner metadata setting ${key} must be a non-empty string: ${path}`,
			);
		}
	}
	return {
		...(typeof record.humanLanguage === "string"
			? { humanLanguage: record.humanLanguage.trim() }
			: {}),
		...(typeof record.titleLanguage === "string"
			? { titleLanguage: record.titleLanguage.trim() }
			: {}),
		...(typeof record.descriptionLanguage === "string"
			? { descriptionLanguage: record.descriptionLanguage.trim() }
			: {}),
		...(typeof record.commitLanguage === "string"
			? { commitLanguage: record.commitLanguage.trim() }
			: {}),
		...(typeof record.doubtReviewLanguage === "string"
			? { doubtReviewLanguage: record.doubtReviewLanguage.trim() }
			: {}),
		...(typeof record.skillLanguage === "string"
			? { skillLanguage: record.skillLanguage.trim() }
			: {}),
	};
}

function mergeMetadataSettings(
	global: PlannerSettingsFile["metadata"] | undefined,
	project: PlannerSettingsFile["metadata"] | undefined,
): PlannerSettings["metadata"] {
	const humanLanguage =
		project?.humanLanguage ??
		global?.humanLanguage ??
		DEFAULT_PLANNER_SETTINGS.metadata.humanLanguage;
	return {
		humanLanguage,
		titleLanguage:
			project?.titleLanguage ??
			project?.humanLanguage ??
			global?.titleLanguage ??
			global?.humanLanguage ??
			DEFAULT_PLANNER_SETTINGS.metadata.titleLanguage,
		descriptionLanguage:
			project?.descriptionLanguage ??
			project?.humanLanguage ??
			global?.descriptionLanguage ??
			global?.humanLanguage ??
			DEFAULT_PLANNER_SETTINGS.metadata.descriptionLanguage,
		commitLanguage:
			project?.commitLanguage ??
			project?.humanLanguage ??
			global?.commitLanguage ??
			global?.humanLanguage ??
			DEFAULT_PLANNER_SETTINGS.metadata.commitLanguage,
		doubtReviewLanguage:
			project?.doubtReviewLanguage ??
			project?.humanLanguage ??
			global?.doubtReviewLanguage ??
			global?.humanLanguage ??
			DEFAULT_PLANNER_SETTINGS.metadata.doubtReviewLanguage,
		skillLanguage:
			project?.skillLanguage ??
			project?.humanLanguage ??
			global?.skillLanguage ??
			global?.humanLanguage ??
			DEFAULT_PLANNER_SETTINGS.metadata.skillLanguage,
	};
}

function normalizeTimerSettings(
	value: unknown,
	path: string,
): PlannerSettingsFile["timer"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`Planner timer settings must be an object: ${path}`);
	}
	const record = value as Record<string, unknown>;
	if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
		throw new TypeError(
			`Planner timer setting enabled must be boolean: ${path}`,
		);
	}
	if (
		record.showCheckpoints !== undefined &&
		typeof record.showCheckpoints !== "boolean"
	) {
		throw new TypeError(
			`Planner timer setting showCheckpoints must be boolean: ${path}`,
		);
	}
	if (
		record.mode !== undefined &&
		record.mode !== "status" &&
		record.mode !== "widget"
	) {
		throw new TypeError(
			`Planner timer setting mode must be "status" or "widget": ${path}`,
		);
	}
	return {
		...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
		...(record.mode === "status" || record.mode === "widget"
			? { mode: record.mode }
			: {}),
		...(typeof record.showCheckpoints === "boolean"
			? { showCheckpoints: record.showCheckpoints }
			: {}),
		...(record.maxCheckpoints === undefined
			? {}
			: {
					maxCheckpoints: positiveInteger(
						record.maxCheckpoints,
						"maxCheckpoints",
						path,
					),
				}),
		...(record.syncIntervalMinutes === undefined
			? {}
			: {
					syncIntervalMinutes: positiveNumber(
						record.syncIntervalMinutes,
						"syncIntervalMinutes",
						path,
					),
				}),
	};
}

function normalizeSkillsSettings(
	value: unknown,
	path: string,
): PlannerSettingsFile["skills"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(`Planner skills settings must be an object: ${path}`);
	}
	const record = value as Record<string, unknown>;
	if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
		throw new TypeError(
			`Planner skills setting enabled must be boolean: ${path}`,
		);
	}
	return {
		...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
		...(record.maxActive === undefined
			? {}
			: {
					maxActive: nonNegativeInteger(
						record.maxActive,
						"skills.maxActive",
						path,
					),
				}),
	};
}

function normalizeContractsSettings(
	value: unknown,
	path: string,
): PlannerSettingsFile["contracts"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(
			`Planner contracts settings must be an object: ${path}`,
		);
	}
	const record = value as Record<string, unknown>;
	if (record.enabled !== undefined && typeof record.enabled !== "boolean") {
		throw new TypeError(
			`Planner contracts setting enabled must be boolean: ${path}`,
		);
	}
	if (
		record.requireAfterTdd !== undefined &&
		typeof record.requireAfterTdd !== "boolean"
	) {
		throw new TypeError(
			`Planner contracts setting requireAfterTdd must be boolean: ${path}`,
		);
	}
	if (
		record.requireBeforeEditOutsideChain !== undefined &&
		typeof record.requireBeforeEditOutsideChain !== "boolean"
	) {
		throw new TypeError(
			`Planner contracts setting requireBeforeEditOutsideChain must be boolean: ${path}`,
		);
	}
	if (
		record.finalPolicy !== undefined &&
		record.finalPolicy !== "ask" &&
		record.finalPolicy !== "keep" &&
		record.finalPolicy !== "remove"
	) {
		throw new TypeError(
			`Planner contracts setting finalPolicy must be "ask", "keep", or "remove": ${path}`,
		);
	}
	return {
		...(typeof record.enabled === "boolean" ? { enabled: record.enabled } : {}),
		...(record.finalPolicy === "ask" ||
		record.finalPolicy === "keep" ||
		record.finalPolicy === "remove"
			? { finalPolicy: record.finalPolicy }
			: {}),
		...(record.scanBatchSize === undefined
			? {}
			: {
					scanBatchSize: positiveInteger(
						record.scanBatchSize,
						"contracts.scanBatchSize",
						path,
					),
				}),
		...(record.statusCharBudget === undefined
			? {}
			: {
					statusCharBudget: positiveInteger(
						record.statusCharBudget,
						"contracts.statusCharBudget",
						path,
					),
				}),
		...(record.readChunkChars === undefined
			? {}
			: {
					readChunkChars: positiveInteger(
						record.readChunkChars,
						"contracts.readChunkChars",
						path,
					),
				}),
		...(record.maxActiveChains === undefined
			? {}
			: {
					maxActiveChains: positiveInteger(
						record.maxActiveChains,
						"contracts.maxActiveChains",
						path,
					),
				}),
		...(record.levelBudgets === undefined
			? {}
			: {
					levelBudgets: normalizeContractLevelBudgets(
						record.levelBudgets,
						path,
					),
				}),
		...(typeof record.requireAfterTdd === "boolean"
			? { requireAfterTdd: record.requireAfterTdd }
			: {}),
		...(typeof record.requireBeforeEditOutsideChain === "boolean"
			? { requireBeforeEditOutsideChain: record.requireBeforeEditOutsideChain }
			: {}),
	};
}

function normalizeContractLevelBudgets(
	value: unknown,
	path: string,
): Partial<PlannerContractLevelBudgets> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError(
			`Planner contracts setting levelBudgets must be an object: ${path}`,
		);
	}
	const record = value as Record<string, unknown>;
	return {
		...(record.root === undefined
			? {}
			: {
					root: positiveInteger(
						record.root,
						"contracts.levelBudgets.root",
						path,
					),
				}),
		...(record.ancestor === undefined
			? {}
			: {
					ancestor: positiveInteger(
						record.ancestor,
						"contracts.levelBudgets.ancestor",
						path,
					),
				}),
		...(record.nearest === undefined
			? {}
			: {
					nearest: positiveInteger(
						record.nearest,
						"contracts.levelBudgets.nearest",
						path,
					),
				}),
	};
}

function mergeContractsSettings(
	global: PlannerSettingsFile["contracts"] | undefined,
	project: PlannerSettingsFile["contracts"] | undefined,
): PlannerSettings["contracts"] {
	return {
		...DEFAULT_PLANNER_SETTINGS.contracts,
		...(global ?? {}),
		...(project ?? {}),
		levelBudgets: {
			...DEFAULT_PLANNER_SETTINGS.contracts.levelBudgets,
			...(global?.levelBudgets ?? {}),
			...(project?.levelBudgets ?? {}),
		},
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

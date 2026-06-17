import type { PlannerCompactBoundaries } from "../storage/schema";

export type WorktreeSettings =
	| { mode: "project-local" }
	| { mode: "custom"; root: string };

export interface PlannerSettings {
	worktree: WorktreeSettings;
	compact: PlannerCompactBoundaries;
	idle: PlannerIdleSettings;
	exec: PlannerExecSettings;
	metadata: PlannerMetadataSettings;
	timer: PlannerTimerSettings;
	skills: PlannerSkillsSettings;
	contracts: PlannerContractsSettings;
	workspace: PlannerWorkspaceSettings;
}

export interface PlannerSettingsFile {
	worktree?: WorktreeSettings;
	compact?: Partial<PlannerCompactBoundaries>;
	idle?: Partial<PlannerIdleSettings>;
	exec?: Partial<PlannerExecSettings>;
	metadata?: Partial<PlannerMetadataSettings>;
	timer?: Partial<PlannerTimerSettings>;
	skills?: Partial<PlannerSkillsSettings>;
	contracts?: PlannerContractsSettingsFile;
	workspace?: Partial<PlannerWorkspaceSettings>;
}

export interface PlannerWorkspaceSettings {
	/** Master switch for the planner workspace TUI window. */
	enabled: boolean;
	/** Open the workspace automatically for planner-worktree sessions. */
	autoOpen: boolean;
	/** Terminal rows left for Pi's native footer below the workspace. */
	footerReserveRows: number;
	/** Optional overrides for the workspace's own keybindings. */
	keys?: PlannerWorkspaceKeys;
}

export type PlannerWorkspaceAction =
	| "focusNext"
	| "up"
	| "down"
	| "pageUp"
	| "pageDown"
	| "jumpBottom"
	| "jumpTop"
	| "expand"
	| "submit"
	| "exit";

export type PlannerWorkspaceKeys = Partial<
	Record<PlannerWorkspaceAction, string[]>
>;

export interface PlannerIdleSettings {
	enabled: boolean;
	timeoutMinutes: number;
}

export interface PlannerMetadataSettings {
	humanLanguage: string;
	titleLanguage: string;
	descriptionLanguage: string;
	commitLanguage: string;
	doubtReviewLanguage: string;
	skillLanguage: string;
}

export interface PlannerTimerSettings {
	enabled: boolean;
	mode: "status" | "widget";
	showCheckpoints: boolean;
	maxCheckpoints: number;
	syncIntervalMinutes: number;
}

export interface PlannerExecSettings {
	defaultTimeoutSeconds: number;
	maxTimeoutSeconds: number;
	maxOutputBytes: number;
}

export interface PlannerSkillsSettings {
	enabled: boolean;
	maxActive: number;
}

export interface PlannerContractLevelBudgets {
	root: number;
	ancestor: number;
	nearest: number;
}

export interface PlannerContractsSettings {
	enabled: boolean;
	finalPolicy: "ask" | "keep" | "remove";
	scanBatchSize: number;
	statusCharBudget: number;
	readChunkChars: number;
	maxActiveChains: number;
	levelBudgets: PlannerContractLevelBudgets;
	requireAfterTdd: boolean;
	requireBeforeEditOutsideChain: boolean;
}

export interface PlannerContractsSettingsFile
	extends Partial<Omit<PlannerContractsSettings, "levelBudgets">> {
	levelBudgets?: Partial<PlannerContractLevelBudgets>;
}

export const DEFAULT_PLANNER_SETTINGS = {
	worktree: { mode: "project-local" },
	compact: {
		stage: true,
		task: false,
	},
	idle: {
		enabled: true,
		timeoutMinutes: 10,
	},
	exec: {
		defaultTimeoutSeconds: 240,
		maxTimeoutSeconds: 1800,
		maxOutputBytes: 10 * 1024 * 1024,
	},
	metadata: {
		humanLanguage: "English",
		titleLanguage: "English",
		descriptionLanguage: "English",
		commitLanguage: "English",
		doubtReviewLanguage: "English",
		skillLanguage: "English",
	},
	timer: {
		enabled: true,
		mode: "status",
		showCheckpoints: true,
		maxCheckpoints: 5,
		syncIntervalMinutes: 10,
	},
	skills: {
		enabled: true,
		maxActive: 0,
	},
	contracts: {
		enabled: true,
		finalPolicy: "ask",
		scanBatchSize: 10,
		statusCharBudget: 12_000,
		readChunkChars: 6_000,
		maxActiveChains: 3,
		levelBudgets: {
			root: 1_800,
			ancestor: 3_000,
			nearest: 7_000,
		},
		requireAfterTdd: true,
		requireBeforeEditOutsideChain: true,
	},
	workspace: {
		enabled: true,
		autoOpen: true,
		footerReserveRows: 3,
	},
} as const satisfies PlannerSettings;

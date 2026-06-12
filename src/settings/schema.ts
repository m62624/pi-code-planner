import type { PlannerCompactBoundaries } from "../storage/schema";

export type WorktreeSettings =
	| { mode: "project-local" }
	| { mode: "custom"; root: string };

export interface PlannerSettings {
	worktree: WorktreeSettings;
	compact: PlannerCompactBoundaries;
	idle: PlannerIdleSettings;
	metadata: PlannerMetadataSettings;
	timer: PlannerTimerSettings;
	contracts: PlannerContractsSettings;
}

export interface PlannerSettingsFile {
	worktree?: WorktreeSettings;
	compact?: Partial<PlannerCompactBoundaries>;
	idle?: Partial<PlannerIdleSettings>;
	metadata?: Partial<PlannerMetadataSettings>;
	timer?: Partial<PlannerTimerSettings>;
	contracts?: PlannerContractsSettingsFile;
}

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
} as const satisfies PlannerSettings;

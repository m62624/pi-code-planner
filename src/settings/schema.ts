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
}

export interface PlannerSettingsFile {
	worktree?: WorktreeSettings;
	compact?: Partial<PlannerCompactBoundaries>;
	idle?: Partial<PlannerIdleSettings>;
	metadata?: Partial<PlannerMetadataSettings>;
	timer?: Partial<PlannerTimerSettings>;
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
}

export interface PlannerTimerSettings {
	enabled: boolean;
	mode: "status" | "widget";
	showCheckpoints: boolean;
	maxCheckpoints: number;
	syncIntervalMinutes: number;
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
	},
	timer: {
		enabled: true,
		mode: "status",
		showCheckpoints: true,
		maxCheckpoints: 5,
		syncIntervalMinutes: 10,
	},
} as const satisfies PlannerSettings;

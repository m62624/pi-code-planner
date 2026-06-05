import type { PlannerCompactBoundaries } from "../storage/schema";

export type WorktreeSettings =
	| { mode: "project-local" }
	| { mode: "custom"; root: string };

export interface PlannerSettings {
	worktree: WorktreeSettings;
	compact: PlannerCompactBoundaries;
	idle: PlannerIdleSettings;
	metadata: PlannerMetadataSettings;
}

export interface PlannerSettingsFile {
	worktree?: WorktreeSettings;
	compact?: Partial<PlannerCompactBoundaries>;
	idle?: Partial<PlannerIdleSettings>;
	metadata?: Partial<PlannerMetadataSettings>;
}

export interface PlannerIdleSettings {
	enabled: boolean;
	timeoutMinutes: number;
}

export interface PlannerMetadataSettings {
	descriptionLanguage: string;
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
		descriptionLanguage: "English",
	},
} as const satisfies PlannerSettings;

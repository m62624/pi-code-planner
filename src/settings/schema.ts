import type { PlannerCompactBoundaries } from "../storage/schema";

export type WorktreeSettings =
	| { mode: "project-local" }
	| { mode: "custom"; root: string };

export interface PlannerSettings {
	worktree: WorktreeSettings;
	compact: PlannerCompactBoundaries;
	idle: PlannerIdleSettings;
}

export interface PlannerSettingsFile {
	worktree?: WorktreeSettings;
	compact?: Partial<PlannerCompactBoundaries>;
	idle?: Partial<PlannerIdleSettings>;
}

export interface PlannerIdleSettings {
	enabled: boolean;
	timeoutMinutes: number;
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
} as const satisfies PlannerSettings;

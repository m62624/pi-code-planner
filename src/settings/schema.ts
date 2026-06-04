import type { PlannerCompactBoundaries } from "../storage/schema";

export type WorktreeSettings =
	| { mode: "project-local" }
	| { mode: "custom"; root: string };

export interface PlannerSettings {
	worktree: WorktreeSettings;
	compact: PlannerCompactBoundaries;
}

export interface PlannerSettingsFile {
	worktree?: WorktreeSettings;
	compact?: Partial<PlannerCompactBoundaries>;
}

export const DEFAULT_PLANNER_SETTINGS = {
	worktree: { mode: "project-local" },
	compact: {
		stage: true,
		task: false,
	},
} as const satisfies PlannerSettings;

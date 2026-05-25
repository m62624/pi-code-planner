export type WorktreeSettings =
	| { mode: "project-local" }
	| { mode: "custom"; root: string };

export interface PlannerSettings {
	worktree: WorktreeSettings;
}

export interface PlannerSettingsFile {
	worktree?: WorktreeSettings;
}

export const DEFAULT_PLANNER_SETTINGS = {
	worktree: { mode: "project-local" },
} as const satisfies PlannerSettings;

import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";

/**
 * Dependencies shared by every planner tool/command executor: a filesystem
 * handle, a git runner, and the resolved project storage paths. Executor input
 * interfaces extend this instead of re-declaring the same three fields.
 */
export interface PlannerToolContext {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
}

/**
 * Standard wrapper-tool executor input: the shared context plus the dispatched
 * tool name and its raw, not-yet-validated params payload.
 */
export interface PlannerToolExecutionInput<Name extends string>
	extends PlannerToolContext {
	toolName: Name;
	params: unknown;
}

import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProjectStoragePaths } from "../storage/paths";

export type WorktreeLocationKind = "project-local" | "agent-dir" | "custom";

export interface WorktreeLocation {
	kind: WorktreeLocationKind;
	root: string;
	path: string;
}

export function createProjectLocalWorktreeLocation(
	projectPaths: ProjectStoragePaths,
	planId: string,
): WorktreeLocation {
	const root = join(projectPaths.projectLocalDir, "worktrees");
	return {
		kind: "project-local",
		root,
		path: join(root, planId),
	};
}

export function createAgentDirWorktreeLocation(
	projectPaths: ProjectStoragePaths,
	planId: string,
): WorktreeLocation {
	const root = join(projectPaths.projectDir, "worktrees");
	return {
		kind: "agent-dir",
		root,
		path: join(root, planId),
	};
}

export function createCustomWorktreeLocation(input: {
	root: string;
	projectId: string;
	planId: string;
}): WorktreeLocation {
	const root = join(input.root, input.projectId);
	return {
		kind: "custom",
		root,
		path: join(root, input.planId),
	};
}

export function isProjectLocalWorktreePath(
	projectPaths: ProjectStoragePaths,
	worktreePath: string,
): boolean {
	const root = resolve(projectPaths.projectLocalDir, "worktrees");
	const target = resolve(worktreePath);
	const rel = relative(root, target);
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

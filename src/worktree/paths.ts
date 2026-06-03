import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProjectStoragePaths } from "../storage/paths";

export type WorktreeLocationKind = "project-local" | "custom";

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
	const path = join(root, planId);
	let candidate = path;
	let suffix = 1;
	while (existsSync(candidate)) {
		candidate = join(root, `${planId}-${suffix}`);
		suffix++;
	}
	return {
		kind: "project-local",
		root,
		path: candidate,
	};
}

export function createCustomWorktreeLocation(input: {
	root: string;
	projectId: string;
	planId: string;
}): WorktreeLocation {
	const root = join(input.root, input.projectId);
	const path = join(root, input.planId);
	let candidate = path;
	let suffix = 1;
	while (existsSync(candidate)) {
		candidate = join(root, `${input.planId}-${suffix}`);
		suffix++;
	}
	return {
		kind: "custom",
		root,
		path: candidate,
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

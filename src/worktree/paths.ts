import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { compactIdPart } from "../storage/ids";
import type { ProjectStoragePaths } from "../storage/paths";

const WORKTREE_ID_CHARS = 32;

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
	const pathId = compactIdPart(planId, WORKTREE_ID_CHARS);
	const path = join(root, pathId);
	if (!existsSync(path)) {
		return {
			kind: "project-local",
			root,
			path,
		};
	}
	// Path already exists — generate a unique suffix using UUID.
	// This avoids confusion with numeric suffixes and ensures uniqueness.
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const suffix = randomUUID().slice(0, 8);
		const candidate = join(root, `${pathId}-${suffix}`);
		if (!existsSync(candidate)) {
			return {
				kind: "project-local",
				root,
				path: candidate,
			};
		}
	}
	throw new Error(
		`Unable to allocate unique worktree path for plan: ${planId}`,
	);
}

export function createCustomWorktreeLocation(input: {
	root: string;
	projectId: string;
	planId: string;
}): WorktreeLocation {
	// A custom root is user-configured and can be shared across multiple
	// projects (unlike project-local, which is namespaced by the project's
	// own directory tree). Nesting under projectId keeps plans from different
	// projects from colliding on the same planId.
	const root = join(input.root, input.projectId);
	const pathId = compactIdPart(input.planId, WORKTREE_ID_CHARS);
	const path = join(root, pathId);
	if (!existsSync(path)) {
		return {
			kind: "custom",
			root,
			path,
		};
	}
	// Path already exists — generate a unique suffix using UUID.
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const suffix = randomUUID().slice(0, 8);
		const candidate = join(root, `${pathId}-${suffix}`);
		if (!existsSync(candidate)) {
			return {
				kind: "custom",
				root,
				path: candidate,
			};
		}
	}
	throw new Error(
		`Unable to allocate unique worktree path for plan: ${input.planId}`,
	);
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

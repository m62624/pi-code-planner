import { randomUUID } from "node:crypto";
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
		const candidate = join(root, `${planId}-${suffix}`);
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
	const root = join(input.root, input.projectId);
	const path = join(root, input.planId);
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
		const candidate = join(root, `${input.planId}-${suffix}`);
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

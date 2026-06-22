import { isAbsolute, join, relative, resolve } from "node:path";
import { EXTENSION_NAME } from "../constants";
import type { PlannerFs } from "./fs";
import { safeReaddir } from "./fs";
import { createProjectStoragePaths, type ProjectStoragePaths } from "./paths";
import { readProjectRecordIfExists } from "./project-store";
import { readWorktreeProjectIndexIfExists } from "./worktree-index";

const PROJECT_LOCAL_WORKTREE_MARKER = `${EXTENSION_NAME}/worktrees`;

export async function resolveProjectStoragePaths(input: {
	fs: PlannerFs;
	agentDir: string;
	cwd: string;
}): Promise<ProjectStoragePaths> {
	const direct = createProjectStoragePaths({
		agentDir: input.agentDir,
		projectRoot: input.cwd,
	});
	const directProject = await readProjectRecordIfExists(input.fs, direct);
	if (directProject) {
		return direct;
	}

	const worktreeIndex = await readWorktreeProjectIndexIfExists({
		fs: input.fs,
		agentDir: input.agentDir,
		worktreePath: input.cwd,
	});
	if (worktreeIndex) {
		return createProjectStoragePaths({
			agentDir: input.agentDir,
			projectRoot: worktreeIndex.projectRoot,
		});
	}

	const projectLocalRoot = inferProjectRootFromProjectLocalWorktree(input.cwd);
	if (projectLocalRoot) {
		return createProjectStoragePaths({
			agentDir: input.agentDir,
			projectRoot: projectLocalRoot,
		});
	}

	// Fallback: scan known project records only to recover project-local
	// worktrees whose index is missing. Never return an unrelated project root
	// for a normal new cwd.
	const projectRoot = await findExistingProjectRoot({
		fs: input.fs,
		agentDir: input.agentDir,
		cwd: input.cwd,
	});
	if (projectRoot) {
		return createProjectStoragePaths({
			agentDir: input.agentDir,
			projectRoot,
		});
	}

	return direct;
}

async function findExistingProjectRoot(input: {
	fs: PlannerFs;
	agentDir: string;
	cwd: string;
}): Promise<string | null> {
	const projectsDir = join(
		input.agentDir,
		"extensions",
		EXTENSION_NAME,
		"projects",
	);
	const entries = await safeReaddir(input.fs, projectsDir);
	for (const entry of entries) {
		const projectJson = join(projectsDir, entry, "project.json");
		const projectPaths = createProjectStoragePaths({
			agentDir: input.agentDir,
			projectRoot: "",
		});
		const record = await readProjectRecordIfExists(input.fs, {
			...projectPaths,
			projectJson,
		});
		if (
			record?.projectRoot &&
			isInsideProjectLocalWorktree({
				projectRoot: record.projectRoot,
				cwd: input.cwd,
			})
		) {
			return record.projectRoot;
		}
	}
	return null;
}

function inferProjectRootFromProjectLocalWorktree(cwd: string): string | null {
	const normalized = cwd.replace(/\\/g, "/");
	const marker = `/.pi/${PROJECT_LOCAL_WORKTREE_MARKER}/`;
	const index = normalized.indexOf(marker);
	if (index <= 0) {
		return null;
	}
	return normalized.slice(0, index);
}

function isInsideProjectLocalWorktree(input: {
	projectRoot: string;
	cwd: string;
}): boolean {
	const worktreeRoot = resolve(
		input.projectRoot,
		".pi",
		EXTENSION_NAME,
		"worktrees",
	);
	const rel = relative(worktreeRoot, resolve(input.cwd));
	return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

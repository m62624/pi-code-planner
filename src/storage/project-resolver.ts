import { join } from "node:path";
import { EXTENSION_NAME } from "../constants";
import type { PlannerFs } from "./fs";
import { createProjectStoragePaths, type ProjectStoragePaths } from "./paths";
import { readProjectRecordIfExists } from "./project-store";
import { readWorktreeProjectIndexIfExists } from "./worktree-index";

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

	// Fallback: scan extensionDir/projects/ for any known project record.
	// This prevents creating nested worktrees when cwd is inside an existing
	// worktree but the worktree index lookup fails.
	const projectRoot = await findExistingProjectRoot({
		fs: input.fs,
		agentDir: input.agentDir,
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
		const record = await readProjectRecordIfExists(input.fs, {
			projectJson,
		} as Pick<ProjectStoragePaths, "projectJson">);
		if (record?.projectRoot) {
			return record.projectRoot;
		}
	}
	return null;
}

async function safeReaddir(fs: PlannerFs, dir: string): Promise<string[]> {
	try {
		return await fs.readdir(dir);
	} catch {
		return [];
	}
}

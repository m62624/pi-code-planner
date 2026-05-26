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

	return direct;
}

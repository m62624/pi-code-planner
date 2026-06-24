import type { GitRunner } from "./runner";

export interface GitAvailability {
	/** The `git` binary is reachable on PATH. */
	installed: boolean;
	/** `projectRoot` is inside a usable git work tree. Always false when not installed. */
	repository: boolean;
}

/**
 * Probe whether git can back a planner worktree for `projectRoot`.
 *
 * Runners that do not implement the optional probes (test mocks) are assumed
 * to have git present, preserving the behavior planner had before the probes
 * existed. Only the real NodeGitRunner answers them, so production gets the
 * graceful "git missing / no repository" handling while tests stay untouched.
 */
export async function probeGitAvailability(input: {
	git: GitRunner;
	projectRoot: string;
}): Promise<GitAvailability> {
	const installed = input.git.isInstalled
		? await input.git.isInstalled()
		: true;
	if (!installed) {
		return { installed: false, repository: false };
	}
	const repository = input.git.isRepository
		? await input.git.isRepository({ repoRoot: input.projectRoot })
		: true;
	return { installed: true, repository };
}

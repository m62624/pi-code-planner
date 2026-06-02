import type { GitRunner } from "../git/runner";
import type { PlanStateRecord } from "../storage/schema";

export interface PlannerGitReality {
	repoRoot: string;
	branch: string;
	headCommit: string;
	statusPorcelain: string;
	isDirty: boolean;
	hasConflicts: boolean;
}

export type PlannerPreflightAction = "allow" | "require_recovery";

export interface PlannerPreflightDecision {
	action: PlannerPreflightAction;
	reason: string | null;
}

export async function inspectPlannerGitReality(input: {
	git: GitRunner;
	repoRoot: string;
}): Promise<PlannerGitReality> {
	const [branch, headCommit, statusPorcelain] = await Promise.all([
		input.git.currentBranch({ repoRoot: input.repoRoot }),
		input.git.headCommit({ repoRoot: input.repoRoot }),
		input.git.statusPorcelain({ repoRoot: input.repoRoot }),
	]);
	return {
		repoRoot: input.repoRoot,
		branch,
		headCommit,
		statusPorcelain,
		isDirty: statusPorcelain.trim().length > 0,
		hasConflicts: hasConflictStatus(statusPorcelain),
	};
}

export async function runSyncedPlannerGitMutation<T>(input: {
	git: GitRunner;
	state: PlanStateRecord;
	repoRoot: string;
	mutate: (context: { before: PlannerGitReality }) => Promise<T>;
}): Promise<{
	result: T;
	state: PlanStateRecord;
	before: PlannerGitReality;
	after: PlannerGitReality;
}> {
	const before = await inspectPlannerGitReality({
		git: input.git,
		repoRoot: input.repoRoot,
	});
	const result = await input.mutate({ before });
	const after = await inspectPlannerGitReality({
		git: input.git,
		repoRoot: input.repoRoot,
	});
	return {
		result,
		before,
		after,
		state: syncStateAfterPlannerGitMutation({
			state: input.state,
			before,
			after,
		}),
	};
}

export function evaluatePlannerToolPreflight(input: {
	state: PlanStateRecord;
	reality: PlannerGitReality;
}): PlannerPreflightDecision {
	if (input.state.broken || input.state.requiresUserDecision) {
		return {
			action: "require_recovery",
			reason: "Plan is broken or waiting for a user decision.",
		};
	}

	if (input.reality.hasConflicts) {
		return {
			action: "require_recovery",
			reason: "Git worktree has unresolved conflicts.",
		};
	}

	if (
		input.state.currentBranch !== null &&
		input.reality.branch !== input.state.currentBranch
	) {
		return {
			action: "require_recovery",
			reason: `Expected branch ${input.state.currentBranch}, got ${input.reality.branch}.`,
		};
	}

	return { action: "allow", reason: null };
}

export function syncStateAfterPlannerGitMutation(input: {
	state: PlanStateRecord;
	before: PlannerGitReality;
	after: PlannerGitReality;
}): PlanStateRecord {
	const conflicted = input.after.hasConflicts;
	return {
		...input.state,
		stage: conflicted ? "recovery" : input.state.stage,
		step: conflicted ? "inspect_git" : input.state.step,
		stepStatus: conflicted ? "blocked" : input.state.stepStatus,
		currentBranch: input.after.branch,
		broken: conflicted ? true : input.state.broken,
		brokenReason: conflicted
			? "Git worktree has unresolved conflicts after planner git mutation."
			: input.state.brokenReason,
		blockedReason: conflicted
			? "Git worktree has unresolved conflicts after planner git mutation."
			: input.state.blockedReason,
	};
}

function hasConflictStatus(statusPorcelain: string): boolean {
	return statusPorcelain
		.split(/\r?\n/)
		.filter(Boolean)
		.some((line) => {
			const code = line.slice(0, 2);
			return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(code);
		});
}

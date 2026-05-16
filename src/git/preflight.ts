import type { RuntimeStateManager } from "../planner-state/runtime";
import type { PlannerRuntimeState } from "../planner-state/schema";
import {
	checkGitPolicy,
	type GitPolicyDecision,
	type GitPolicyOperation,
} from "./policy";
import { analyzeGitRecovery, type GitRecoveryAnalysis } from "./recovery";
import type { RepoState } from "./state";

export type GitPreflightOperation =
	| "initialize_repo"
	| "start_plan"
	| "start_work_item"
	| "finish_work_item"
	| "switch_branch"
	| "merge_branch"
	| "delete_branch"
	| "recovery";

export interface GitPreflightResult {
	operation: GitPreflightOperation;
	allowed: boolean;
	kind: "allow" | "block" | "recovery_required";
	message: string;
	recovery: GitRecoveryAnalysis;
	policy?: GitPolicyDecision;
	repoState: RepoState;
}

export interface GitPreflightServiceDeps {
	state: RuntimeStateManager;
	readRepoState: () => Promise<RepoState>;
}

export interface GitPreflightService {
	check(operation: GitPreflightOperation): Promise<GitPreflightResult>;
}

function result(
	operation: GitPreflightOperation,
	repoState: RepoState,
	recovery: GitRecoveryAnalysis,
	kind: GitPreflightResult["kind"],
	message: string,
	policy?: GitPolicyDecision,
): GitPreflightResult {
	return {
		operation,
		allowed: kind === "allow",
		kind,
		message,
		recovery,
		policy,
		repoState,
	};
}

function fromPolicy(
	operation: GitPreflightOperation,
	repoState: RepoState,
	recovery: GitRecoveryAnalysis,
	policy: GitPolicyDecision,
): GitPreflightResult {
	return result(
		operation,
		repoState,
		recovery,
		policy.kind,
		policy.message,
		policy,
	);
}

function blockForRecovery(
	operation: GitPreflightOperation,
	repoState: RepoState,
	recovery: GitRecoveryAnalysis,
): GitPreflightResult {
	return result(
		operation,
		repoState,
		recovery,
		"recovery_required",
		recovery.message,
	);
}

function resolveTargetBranch(plannerState: PlannerRuntimeState): string | null {
	if (!plannerState.activeWorkItemId) {
		return null;
	}
	for (const branch of Object.values(plannerState.branches.items)) {
		if (
			branch.kind === "child" &&
			branch.workItemId === plannerState.activeWorkItemId
		) {
			return branch.name;
		}
	}
	return null;
}

export function createGitPreflightService(
	deps: GitPreflightServiceDeps,
): GitPreflightService {
	return {
		async check(operation) {
			const plannerState = deps.state.get();
			const repoState = await deps.readRepoState();
			const recovery = analyzeGitRecovery(plannerState, repoState);

			if (operation === "initialize_repo") {
				return result(
					operation,
					repoState,
					recovery,
					repoState.isRepo ? "block" : "allow",
					repoState.isRepo
						? "Git repository already exists."
						: "Git repository can be initialized.",
				);
			}

			if (operation === "recovery") {
				return result(
					operation,
					repoState,
					recovery,
					recovery.requiresRecovery ? "allow" : "block",
					recovery.requiresRecovery
						? recovery.message
						: "Recovery is not required.",
				);
			}

			if (operation === "start_plan") {
				return fromPolicy(
					operation,
					repoState,
					recovery,
					checkGitPolicy({
						operation: "start_plan",
						repoState,
						plannerState,
					}),
				);
			}

			if (
				recovery.requiresRecovery &&
				!(
					operation === "finish_work_item" &&
					recovery.status === "dirty_worktree"
				)
			) {
				return blockForRecovery(operation, repoState, recovery);
			}

			const targetBranch =
				operation === "merge_branch" || operation === "switch_branch"
					? resolveTargetBranch(plannerState)
					: undefined;

			const policyOperation: GitPolicyOperation = operation;

			return fromPolicy(
				operation,
				repoState,
				recovery,
				checkGitPolicy({
					operation: policyOperation,
					repoState,
					plannerState,
					targetBranch,
				}),
			);
		},
	};
}

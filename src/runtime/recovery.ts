import type { GitRunner } from "../git/runner";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import type { PlanStateRecord } from "../storage/schema";
import { type ActivePlanContext, readActivePlanContext } from "./active-plan";
import {
	inspectPlannerGitReality,
	type PlannerGitReality,
} from "./git-state-sync";
import type { PlannerRuntimeRecoveryReason } from "./planner-runtime";
import { isBeforePlannerWorktreeStep } from "./state-machine";

export type PlannerRecoveryIssueCode =
	| PlannerRuntimeRecoveryReason
	| "no_active_plan"
	| "no_issue"
	| "external_commit"
	| "dirty_worktree"
	| "managed_branch_missing";

export type PlannerRecoveryIssueSeverity = "info" | "warning" | "blocking";

export interface PlannerRecoveryIssue {
	code: PlannerRecoveryIssueCode;
	severity: PlannerRecoveryIssueSeverity;
	message: string;
}

export interface PlannerRecoveryBranchInspection {
	branch: string;
	role: string;
	exists: boolean | null;
}

export interface PlannerRecoveryInspection {
	status: "ready" | "unavailable";
	contextStatus: ActivePlanContext["status"];
	activePlanId: string | null;
	recoveryRequired: boolean;
	recommendedNextAction: string;
	issues: PlannerRecoveryIssue[];
	expected: {
		stage: string | null;
		step: string | null;
		stepStatus: string | null;
		worktreePath: string | null;
		currentBranch: string | null;
		requiresCompact: boolean | null;
		requiresUserDecision: boolean | null;
		broken: boolean | null;
		brokenReason: string | null;
		activeBranches: unknown;
		mergeTargets: unknown;
	};
	actual: {
		worktreeExists: boolean | null;
		git: PlannerGitReality | null;
		branches: PlannerRecoveryBranchInspection[];
	};
	safeOptions: string[];
	destructiveOptions: string[];
}

export async function inspectPlannerRecovery(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
}): Promise<PlannerRecoveryInspection> {
	const context = await readActivePlanContext({
		fs: input.fs,
		projectPaths: input.projectPaths,
	});

	if (context.status !== "ready") {
		const issue = unavailableContextIssue(context);
		return {
			status: "unavailable",
			contextStatus: context.status,
			activePlanId: context.activePlanId,
			recoveryRequired: issue.severity === "blocking",
			recommendedNextAction: recoveryRecommendation([issue]),
			issues: [issue],
			expected: emptyExpected(),
			actual: {
				worktreeExists: null,
				git: null,
				branches: [],
			},
			safeOptions: safeOptionsForIssues([issue]),
			destructiveOptions: destructiveOptionsForIssues([issue]),
		};
	}

	const state = context.state;
	const worktreeExists = state.worktreePath
		? await input.fs.exists(state.worktreePath)
		: false;
	const gitReality =
		state.worktreePath && worktreeExists
			? await safeInspectGitReality({
					git: input.git,
					repoRoot: state.worktreePath,
				})
			: null;
	const branches = await inspectManagedBranches({
		git: input.git,
		repoRoot: input.projectPaths.projectRoot,
		state,
	});
	const issues = classifyRecoveryIssues({
		state,
		worktreeExists,
		gitReality,
		branches,
	});

	return {
		status: "ready",
		contextStatus: context.status,
		activePlanId: context.activePlanId,
		recoveryRequired: issues.some((issue) => issue.severity === "blocking"),
		recommendedNextAction: recoveryRecommendation(issues),
		issues,
		expected: {
			stage: state.stage,
			step: state.step,
			stepStatus: state.stepStatus,
			worktreePath: state.worktreePath,
			currentBranch: state.currentBranch,
			requiresCompact: state.requiresCompact,
			requiresUserDecision: state.requiresUserDecision,
			broken: state.broken,
			brokenReason: state.brokenReason,
			activeBranches: state.activeBranches,
			mergeTargets: state.mergeTargets,
		},
		actual: {
			worktreeExists,
			git: gitReality,
			branches,
		},
		safeOptions: safeOptionsForIssues(issues),
		destructiveOptions: destructiveOptionsForIssues(issues),
	};
}

export function formatPlannerRecoveryInspection(
	inspection: PlannerRecoveryInspection,
): string {
	const lines = [
		"# Planner Recovery Inspection",
		"",
		`- status: ${inspection.status}`,
		`- contextStatus: ${inspection.contextStatus}`,
		`- activePlanId: ${inspection.activePlanId ?? "(none)"}`,
		`- recoveryRequired: ${String(inspection.recoveryRequired)}`,
		`- recommendedNextAction: ${inspection.recommendedNextAction}`,
		"",
		"## Issues",
		...formatIssues(inspection.issues),
		"",
		"## Expected State",
		`- stage: ${inspection.expected.stage ?? "(none)"}`,
		`- step: ${inspection.expected.step ?? "(none)"}`,
		`- stepStatus: ${inspection.expected.stepStatus ?? "(none)"}`,
		`- worktreePath: ${inspection.expected.worktreePath ?? "(none)"}`,
		`- currentBranch: ${inspection.expected.currentBranch ?? "(none)"}`,
		`- requiresCompact: ${String(inspection.expected.requiresCompact)}`,
		`- requiresUserDecision: ${String(inspection.expected.requiresUserDecision)}`,
		`- broken: ${String(inspection.expected.broken)}`,
		`- brokenReason: ${inspection.expected.brokenReason ?? "(none)"}`,
		`- activeBranches: ${JSON.stringify(inspection.expected.activeBranches)}`,
		`- mergeTargets: ${JSON.stringify(inspection.expected.mergeTargets)}`,
		"",
		"## Actual Git",
		`- worktreeExists: ${String(inspection.actual.worktreeExists)}`,
		`- gitBranch: ${inspection.actual.git?.branch ?? "(unavailable)"}`,
		`- gitHEAD: ${inspection.actual.git?.headCommit ?? "(unavailable)"}`,
		`- gitDirty: ${inspection.actual.git ? String(inspection.actual.git.isDirty) : "(unavailable)"}`,
		`- gitConflicts: ${inspection.actual.git ? String(inspection.actual.git.hasConflicts) : "(unavailable)"}`,
		"",
		"## Managed Branches",
		...formatBranches(inspection.actual.branches),
		"",
		"## Safe Options",
		...formatOptions(inspection.safeOptions),
		"",
		"## Destructive Options Requiring Explicit User Approval",
		...formatOptions(inspection.destructiveOptions),
		"",
		"Raw git remains forbidden while planner is active. Do not reset, delete, checkout, merge, or force anything from shell.",
	];
	return lines.join("\n");
}

function classifyRecoveryIssues(input: {
	state: PlanStateRecord;
	worktreeExists: boolean;
	gitReality: PlannerGitReality | null;
	branches: readonly PlannerRecoveryBranchInspection[];
}): PlannerRecoveryIssue[] {
	const issues: PlannerRecoveryIssue[] = [];
	const { state, gitReality } = input;

	if (state.requiresUserDecision) {
		issues.push({
			code: "user_decision_required",
			severity: "blocking",
			message: "Plan is waiting for a user decision.",
		});
	}
	if (state.broken) {
		issues.push({
			code: "broken_state",
			severity: "blocking",
			message: state.brokenReason ?? "Plan state is marked broken.",
		});
	}
	if (
		(!state.worktreePath || !input.worktreeExists) &&
		!isBeforePlannerWorktreeStep(state)
	) {
		issues.push({
			code: "missing_worktree",
			severity: "blocking",
			message: "Expected planner worktree is missing.",
		});
	}
	if (state.worktreePath && input.worktreeExists && !gitReality) {
		issues.push({
			code: "git_unavailable",
			severity: "blocking",
			message: "Git reality could not be inspected in the planner worktree.",
		});
	}
	if (gitReality?.hasConflicts) {
		issues.push({
			code: "git_conflict",
			severity: "blocking",
			message: "Git worktree has unresolved conflicts.",
		});
	}
	if (
		gitReality &&
		state.currentBranch !== null &&
		gitReality.branch !== state.currentBranch
	) {
		issues.push({
			code: "wrong_branch",
			severity: "blocking",
			message: `Expected branch ${state.currentBranch}, got ${gitReality.branch}. Actual branch role: ${branchRole(state, gitReality.branch)}.`,
		});
	}
	if (gitReality?.isDirty) {
		issues.push({
			code: "dirty_worktree",
			severity: "warning",
			message:
				"Worktree has uncommitted changes. This is allowed inside active work, but not at plan-switch boundaries.",
		});
	}
	for (const branch of input.branches) {
		if (branch.exists === false) {
			issues.push({
				code: "managed_branch_missing",
				severity: "warning",
				message: `Managed branch is missing: ${branch.branch} (${branch.role}).`,
			});
		}
	}

	return issues.length > 0
		? issues
		: [
				{
					code: "no_issue",
					severity: "info",
					message: "No recovery issue detected.",
				},
			];
}

async function inspectManagedBranches(input: {
	git: GitRunner;
	repoRoot: string;
	state: PlanStateRecord;
}): Promise<PlannerRecoveryBranchInspection[]> {
	const branches = knownManagedBranches(input.state);
	const inspected: PlannerRecoveryBranchInspection[] = [];
	for (const [branch, role] of branches) {
		inspected.push({
			branch,
			role,
			exists: await safeBranchExists({
				git: input.git,
				repoRoot: input.repoRoot,
				branch,
			}),
		});
	}
	return inspected;
}

function knownManagedBranches(
	state: PlanStateRecord,
): Array<[branch: string, role: string]> {
	const values: Array<[string | null, string]> = [
		[state.activeBranches.base, "base"],
		[state.activeBranches.plan, "plan"],
		[state.activeBranches.currentTask, "currentTask"],
		[state.mergeTargets.taskToPlan, "mergeTarget.taskToPlan"],
		[state.mergeTargets.planToOutput, "mergeTarget.planToOutput"],
	];
	for (const [taskId, registry] of Object.entries(
		state.managedBranches.tasks,
	)) {
		values.push(
			[registry.task, `managed.${taskId}.task`],
			[registry.refactor, `managed.${taskId}.refactor`],
		);
	}

	const seen = new Set<string>();
	const result: Array<[string, string]> = [];
	for (const [branch, role] of values) {
		if (!branch || seen.has(branch)) continue;
		seen.add(branch);
		result.push([branch, role]);
	}
	return result;
}

function branchRole(state: PlanStateRecord, branch: string): string {
	return (
		knownManagedBranches(state).find(
			([candidate]) => candidate === branch,
		)?.[1] ?? "unmanaged"
	);
}

function unavailableContextIssue(
	context: Exclude<ActivePlanContext, { status: "ready" }>,
): PlannerRecoveryIssue {
	switch (context.status) {
		case "missing_project":
			return {
				code: "missing_project",
				severity: "blocking",
				message: context.reason,
			};
		case "no_active_plan":
			return {
				code: "no_active_plan",
				severity: "info",
				message: context.reason,
			};
		case "missing_plan":
			return {
				code: "missing_plan",
				severity: "blocking",
				message: context.reason,
			};
		case "missing_state":
			return {
				code: "missing_state",
				severity: "blocking",
				message: context.reason,
			};
	}
}

function recoveryRecommendation(
	issues: readonly PlannerRecoveryIssue[],
): string {
	if (issues.some((issue) => issue.code === "no_active_plan")) {
		return "No recovery action is needed because no planner plan is active.";
	}
	if (issues.some((issue) => issue.code === "no_issue")) {
		return "No recovery issue detected. Call planner_status and continue normal flow.";
	}
	if (issues.some((issue) => issue.code === "missing_plan")) {
		return "Ask the user whether to remove the stale activePlanId or restore the missing plan files.";
	}
	if (issues.some((issue) => issue.code === "missing_state")) {
		return "Ask the user whether to restore state.json or delete the broken plan.";
	}
	if (issues.some((issue) => issue.code === "git_conflict")) {
		return "Stop normal flow. Ask the user before aborting merge, resetting, or resolving conflicts.";
	}
	if (issues.some((issue) => issue.code === "wrong_branch")) {
		return "Do not continue on the wrong branch. planner_recovery_resume realigns a clean worktree back to the expected branch automatically; if the worktree is dirty or mid-conflict, ask the user before any switch.";
	}
	if (issues.some((issue) => issue.code === "dirty_worktree")) {
		return "Do not switch plans until dirty changes are committed, reverted by user approval, or explained.";
	}
	if (issues.some((issue) => issue.severity === "blocking")) {
		return "Stay in recovery and ask the user before destructive repair.";
	}
	return "No recovery issue detected. Call planner_status and continue normal flow.";
}

function safeOptionsForIssues(
	issues: readonly PlannerRecoveryIssue[],
): string[] {
	const options = new Set<string>(["Call planner_status after inspection."]);
	if (issues.some((issue) => issue.code === "wrong_branch")) {
		options.add(
			"Call planner_recovery_resume: it switches a clean worktree back to the expected branch automatically (non-destructive checkout, no reset or delete).",
		);
	}
	if (issues.some((issue) => issue.code === "dirty_worktree")) {
		options.add(
			"Commit intentional changes through planner git tools if the current step allows it.",
		);
	}
	if (issues.every((issue) => issue.severity !== "blocking")) {
		options.add(
			"If state is otherwise consistent, resume through planner_resume_after_recovery with an explicit non-recovery target.",
		);
	}
	return [...options];
}

function destructiveOptionsForIssues(
	issues: readonly PlannerRecoveryIssue[],
): string[] {
	const options = new Set<string>();
	if (
		issues.some((issue) =>
			["dirty_worktree", "wrong_branch", "git_conflict"].includes(issue.code),
		)
	) {
		options.add(
			"Discard uncommitted work, abort merge, hard reset, or force checkout only after explicit user approval.",
		);
	}
	if (
		issues.some((issue) =>
			["missing_plan", "missing_state", "missing_worktree"].includes(
				issue.code,
			),
		)
	) {
		options.add(
			"Delete broken planner files/worktree references only after explicit user approval.",
		);
	}
	return [...options];
}

function emptyExpected(): PlannerRecoveryInspection["expected"] {
	return {
		stage: null,
		step: null,
		stepStatus: null,
		worktreePath: null,
		currentBranch: null,
		requiresCompact: null,
		requiresUserDecision: null,
		broken: null,
		brokenReason: null,
		activeBranches: null,
		mergeTargets: null,
	};
}

function formatIssues(issues: readonly PlannerRecoveryIssue[]): string[] {
	return issues.map(
		(issue) => `- [${issue.severity}] ${issue.code}: ${issue.message}`,
	);
}

function formatBranches(
	branches: readonly PlannerRecoveryBranchInspection[],
): string[] {
	if (branches.length === 0) {
		return ["- (none)"];
	}
	return branches.map(
		(branch) =>
			`- ${branch.branch} (${branch.role}): ${branch.exists === null ? "unknown" : branch.exists ? "exists" : "missing"}`,
	);
}

function formatOptions(options: readonly string[]): string[] {
	return options.length > 0
		? options.map((option) => `- ${option}`)
		: ["- (none)"];
}

export interface WrongBranchRepairResult {
	repaired: boolean;
	from: string | null;
	to: string | null;
	skippedReason: string | null;
}

/**
 * Non-destructively realign the worktree to the branch plan state expects.
 *
 * A failed mid-flight git mutation (e.g. an aborted task→plan merge) can leave
 * the worktree checked out on a different branch than state.currentBranch,
 * which recovery flags as the blocking `wrong_branch` issue. Because raw git is
 * forbidden while the planner is active, the user otherwise has no way to fix
 * it. This performs the one safe repair the recovery recommendation already
 * describes: when the worktree is clean and the expected branch still exists,
 * check it back out. It never resets, deletes, or discards anything — if the
 * worktree is dirty or mid-conflict, it does nothing and leaves the decision to
 * the user.
 */
export async function repairWrongBranchIfSafe(input: {
	git: GitRunner;
	state: PlanStateRecord;
}): Promise<WrongBranchRepairResult> {
	const { state } = input;
	const skip = (skippedReason: string): WrongBranchRepairResult => ({
		repaired: false,
		from: null,
		to: null,
		skippedReason,
	});
	if (!state.worktreePath || !state.currentBranch) {
		return skip("no worktree path or expected branch recorded in state");
	}
	const reality = await safeInspectGitReality({
		git: input.git,
		repoRoot: state.worktreePath,
	});
	if (!reality) {
		return skip("git reality could not be inspected");
	}
	if (reality.branch === state.currentBranch) {
		return skip("worktree already on the expected branch");
	}
	if (reality.isDirty || reality.hasConflicts) {
		return skip("worktree is not clean; ask the user before switching");
	}
	const expectedExists = await safeBranchExists({
		git: input.git,
		repoRoot: state.worktreePath,
		branch: state.currentBranch,
	});
	if (expectedExists !== true) {
		return skip("expected branch does not exist");
	}
	try {
		await input.git.switchBranch({
			repoRoot: state.worktreePath,
			branch: state.currentBranch,
		});
	} catch {
		return skip("checkout to the expected branch failed");
	}
	return {
		repaired: true,
		from: reality.branch,
		to: state.currentBranch,
		skippedReason: null,
	};
}

async function safeInspectGitReality(input: {
	git: GitRunner;
	repoRoot: string;
}): Promise<PlannerGitReality | null> {
	try {
		return await inspectPlannerGitReality(input);
	} catch {
		return null;
	}
}

async function safeBranchExists(input: {
	git: GitRunner;
	repoRoot: string;
	branch: string;
}): Promise<boolean | null> {
	try {
		return await input.git.branchExists({
			repoRoot: input.repoRoot,
			branch: input.branch,
		});
	} catch {
		return null;
	}
}

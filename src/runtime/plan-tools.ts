import { randomUUID } from "node:crypto";
import { SCHEMA_VERSION } from "../constants";
import { errorMessage } from "../errors";
import { planBranchName } from "../git/branches";
import type { GitRunner } from "../git/runner";
import { syncBundledInstructionFiles } from "../instructions/defaults";
import { createInstructionPaths } from "../instructions/paths";
import { loadEffectivePlannerSettings } from "../settings/manager";
import type { WorktreeSettings } from "../settings/schema";
import type { PlannerFs } from "../storage/fs";
import {
	createPlanStoragePaths,
	type PlanStoragePaths,
	type ProjectStoragePaths,
} from "../storage/paths";
import {
	initializePlanFiles,
	readPlanRecordIfExists,
} from "../storage/plan-store";
import {
	ensureProjectRecord,
	setActivePlan,
	upsertProjectPlanSummary,
} from "../storage/project-store";
import { createInitialPlanState, createPlanRecord } from "../storage/schema";
import {
	initializePlanState,
	readPlanStateIfExists,
} from "../storage/state-store";
import { saveWorktreeProjectIndex } from "../storage/worktree-index";
import type { CreatePlanWorktreeResult } from "../worktree/manager";
import { createPlanWorktree } from "../worktree/manager";
import {
	createCustomWorktreeLocation,
	createProjectLocalWorktreeLocation,
} from "../worktree/paths";
import type { PlannerGitReality } from "./git-state-sync";
import { inspectPlannerGitReality } from "./git-state-sync";
import { asObject } from "./params";
import {
	createPlannerPlanDescription,
	createPlannerPlanTitle,
	resolvePlannerPlanId,
	validatePlannerPlanTitle,
} from "./plan-naming";
import type { PlannerToolExecutionInput } from "./tool-context";
import {
	appliedResult,
	blockedResult,
	type PlannerToolResult,
} from "./tool-result";

export const PLANNER_PLAN_TOOL_NAMES = ["planner_create_plan"] as const;

export type PlannerPlanToolName = (typeof PLANNER_PLAN_TOOL_NAMES)[number];

export type PlannerPlanToolExecutionInput =
	PlannerToolExecutionInput<PlannerPlanToolName>;

export type PlannerPlanToolExecutionResult =
	PlannerToolResult<PlannerPlanToolName>;

export async function executePlannerPlanTool(
	input: PlannerPlanToolExecutionInput,
): Promise<PlannerPlanToolExecutionResult> {
	try {
		switch (input.toolName) {
			case "planner_create_plan":
				return await createPlanTool(input);
		}
	} catch (error) {
		return blocked(input.toolName, errorMessage(error), { error });
	}
}

/**
 * Reasons a plan is persisted without a worktree. The caller (the /planner-create
 * command) passes "git-missing"/"no-repository" through the degradedReason param
 * after probing git; "bootstrap-failed" is produced internally when git crashes
 * mid-bootstrap despite a healthy probe.
 */
export const PLAN_DEGRADED_REASON_MESSAGES = {
	"git-missing":
		"Git is not installed, so the planner could not create a worktree. Install git to continue.",
	"no-repository":
		"No git repository was found here, so the planner could not create a worktree. Run `git init` (or let /planner-create initialize one) to continue.",
	"bootstrap-failed": "The planner could not create the git worktree.",
} as const;

export type PlanDegradedReason = keyof typeof PLAN_DEGRADED_REASON_MESSAGES;

function isPlanDegradedReason(
	value: string | null,
): value is PlanDegradedReason {
	return value !== null && value in PLAN_DEGRADED_REASON_MESSAGES;
}

async function createPlanTool(
	input: PlannerPlanToolExecutionInput,
): Promise<PlannerPlanToolExecutionResult> {
	const params = asObject(input.params);
	const request = requiredString(params, "request");
	const title =
		optionalString(params, "title") ?? createPlannerPlanTitle(request);
	const validatedTitle = validatePlannerPlanTitle(title);
	const description =
		optionalString(params, "description") ??
		createPlannerPlanDescription(request);
	const degradedReasonParam = optionalString(params, "degradedReason");
	const degradedReason = isPlanDegradedReason(degradedReasonParam)
		? degradedReasonParam
		: null;
	const project = await ensureProjectRecord(input.fs, input.projectPaths);
	const planId = resolvePlannerPlanId({
		requestedPlanId: optionalString(params, "planId") ?? undefined,
		request,
		project,
	});

	const planPaths = createPlanStoragePaths(input.projectPaths, planId);
	const existingPlan = await readPlanRecordIfExists(input.fs, planPaths);
	const existingState = await readPlanStateIfExists(input.fs, planPaths);
	if (existingPlan || existingState) {
		return blocked(input.toolName, `Planner plan already exists: ${planId}.`, {
			planId,
			planPaths,
			existingPlan: Boolean(existingPlan),
			existingState: Boolean(existingState),
		});
	}

	const baseBranch =
		optionalString(params, "baseBranch") ??
		(await safeCurrentBranch(input.git, input.projectPaths.projectRoot)) ??
		"main";
	const planBranch = planBranchName(planId);
	const plan = createPlanRecord({
		planId,
		title: validatedTitle,
		description,
		status: "active",
	});
	const settings = await loadEffectivePlannerSettings({
		fs: input.fs,
		projectPaths: input.projectPaths,
	});
	const worktreeLocation = worktreeLocationForPlan({
		projectPaths: input.projectPaths,
		planId,
		worktree: settings.effective.worktree,
	});

	// Instruction defaults are git-free; sync them regardless of git health.
	await syncBundledInstructionFiles(
		input.fs,
		createInstructionPaths(input.projectPaths),
	);

	// Persist the request + plan record BEFORE any git work, so a git failure or
	// a crash after the user typed the request can never lose it.
	await initializePlanFiles(input.fs, planPaths, plan);
	await input.fs.writeTextAtomic(planPaths.requestMd, `${request.trim()}\n`);

	const pendingArgs = {
		fs: input.fs,
		projectPaths: input.projectPaths,
		toolName: input.toolName,
		planPaths,
		planId,
		validatedTitle,
		description,
		baseBranch,
		planBranch,
		worktreeLocation,
	};

	// The caller already determined git is unavailable (missing binary, no repo,
	// or the user declined `git init`): persist a bootstrap-pending plan and
	// report where the request is saved instead of attempting git.
	if (degradedReason) {
		return await persistPendingPlan({
			...pendingArgs,
			reason: degradedReason,
			error: null,
		});
	}

	try {
		const uniqueBranch = await resolveUniquePlanBranch({
			git: input.git,
			repoRoot: input.projectPaths.projectRoot,
			planBranch,
		});
		const { worktree, reality } = await bootstrapPlanWorktree({
			fs: input.fs,
			git: input.git,
			projectPaths: input.projectPaths,
			planId,
			worktreeLocation,
			planBranch: uniqueBranch,
			baseBranch,
		});
		const state = {
			...createInitialPlanState({
				baseBranch,
				planBranch: uniqueBranch,
				worktreePath: worktreeLocation,
			}),
			stage: "intake",
			step: "draft_goal",
			stepStatus: "running",
			currentBranch: reality.branch,
			worktreeBootstrapPending: false,
		} as const;
		await initializePlanState(input.fs, planPaths, state);
		await upsertProjectPlanSummary(input.fs, input.projectPaths, {
			planId,
			title: validatedTitle,
			description,
			status: "active",
		});
		const nextProject = await setActivePlan(
			input.fs,
			input.projectPaths,
			planId,
		);

		return applied(
			input.toolName,
			[
				"Planner plan created.",
				`Plan: ${planId}`,
				`Provisional title: ${validatedTitle}`,
				`Description: ${description}`,
				`Base branch: ${baseBranch}`,
				`Worktree: ${worktreeLocation}`,
				"Next: switch/open Pi in the planner worktree session, call planner_status, draft goal.md in your own words, and wait for explicit user approval before discovery. Ask evidence-based clarification questions only after discovery.",
			].join("\n"),
			{
				project: nextProject,
				plan,
				state,
				planPaths,
				worktree,
				settings,
			},
		);
	} catch (error) {
		// Git failed mid-bootstrap (binary vanished, repository broke, etc.). The
		// request is already on disk; persist a bootstrap-pending plan so the work
		// survives and /planner-resume can retry the worktree creation later.
		return await persistPendingPlan({
			...pendingArgs,
			reason: "bootstrap-failed",
			error,
		});
	}
}

interface PersistPendingPlanArgs {
	fs: PlannerFs;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerPlanToolName;
	planPaths: PlanStoragePaths;
	planId: string;
	validatedTitle: string;
	description: string;
	baseBranch: string;
	planBranch: string;
	worktreeLocation: string;
	reason: PlanDegradedReason;
	error: unknown;
}

/**
 * Record a plan whose worktree could not be created yet. The plan record and
 * request.md were already written by the caller; this writes a
 * worktreeBootstrapPending state and a paused summary (deliberately NOT active —
 * there is no worktree to switch into) and returns a blocked-but-degraded result
 * pointing at the saved request.
 */
async function persistPendingPlan(
	args: PersistPendingPlanArgs,
): Promise<PlannerPlanToolExecutionResult> {
	const pendingState = {
		...createInitialPlanState({
			baseBranch: args.baseBranch,
			planBranch: args.planBranch,
			worktreePath: args.worktreeLocation,
		}),
		worktreeBootstrapPending: true,
	} as const;
	await initializePlanState(args.fs, args.planPaths, pendingState);
	await upsertProjectPlanSummary(args.fs, args.projectPaths, {
		planId: args.planId,
		title: args.validatedTitle,
		description: args.description,
		status: "paused",
	});
	const text = [
		PLAN_DEGRADED_REASON_MESSAGES[args.reason],
		`Your request is saved at: ${args.planPaths.requestMd}`,
		`The plan "${args.planId}" was recorded. Resume it with /planner-resume once git is available and the planner will finish creating the worktree.`,
		...(args.error ? [`Git error: ${errorMessage(args.error)}`] : []),
	].join("\n");
	return {
		status: "blocked",
		toolName: args.toolName,
		text,
		details: {
			degraded: true,
			reason: args.reason,
			planId: args.planId,
			planPaths: args.planPaths,
			requestMd: args.planPaths.requestMd,
			worktreePath: args.worktreeLocation,
			...(args.error ? { error: args.error } : {}),
		},
	};
}

/** Append a short UUID suffix when the plan branch name already exists. */
export async function resolveUniquePlanBranch(input: {
	git: GitRunner;
	repoRoot: string;
	planBranch: string;
}): Promise<string> {
	const exists = await input.git.branchExists({
		repoRoot: input.repoRoot,
		branch: input.planBranch,
	});
	return exists
		? `${input.planBranch}-${randomUUID().slice(0, 8)}`
		: input.planBranch;
}

/**
 * Create the git worktree for a plan and record its project index entry. Shared
 * by initial creation and by /planner-resume's rebootstrap of a plan that was
 * persisted while git was unavailable.
 */
export async function bootstrapPlanWorktree(input: {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	planId: string;
	worktreeLocation: string;
	planBranch: string;
	baseBranch: string;
}): Promise<{
	worktree: CreatePlanWorktreeResult;
	reality: PlannerGitReality;
}> {
	const worktree = await createPlanWorktree({
		fs: input.fs,
		git: input.git,
		projectPaths: input.projectPaths,
		worktreePath: input.worktreeLocation,
		branch: input.planBranch,
		fromRef: input.baseBranch,
	});
	const reality = await inspectPlannerGitReality({
		git: input.git,
		repoRoot: input.worktreeLocation,
	});
	await saveWorktreeProjectIndex({
		fs: input.fs,
		agentDir: input.projectPaths.agentDir,
		record: {
			schemaVersion: SCHEMA_VERSION,
			worktreePath: input.worktreeLocation,
			projectRoot: input.projectPaths.projectRoot,
			projectId: input.projectPaths.projectId,
			planId: input.planId,
		},
	});
	return { worktree, reality };
}

function worktreeLocationForPlan(input: {
	projectPaths: ProjectStoragePaths;
	planId: string;
	worktree: WorktreeSettings;
}): string {
	if (input.worktree.mode === "custom") {
		return createCustomWorktreeLocation({
			root: input.worktree.root,
			projectId: input.projectPaths.projectId,
			planId: input.planId,
		}).path;
	}
	return createProjectLocalWorktreeLocation(input.projectPaths, input.planId)
		.path;
}

async function safeCurrentBranch(
	git: GitRunner,
	repoRoot: string,
): Promise<string | null> {
	try {
		const branch = await git.currentBranch({ repoRoot });
		return branch.trim().length > 0 ? branch : null;
	} catch {
		return null;
	}
}

function requiredString(params: Record<string, unknown>, key: string): string {
	const value = params[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`Missing required string parameter: ${key}.`);
	}
	return value.trim();
}

function optionalString(
	params: Record<string, unknown>,
	key: string,
): string | null {
	const value = params[key];
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function applied(
	toolName: PlannerPlanToolName,
	text: string,
	details: unknown,
): PlannerPlanToolExecutionResult {
	return appliedResult(toolName, text, details);
}

function blocked(
	toolName: PlannerPlanToolName,
	text: string,
	details: unknown,
): PlannerPlanToolExecutionResult {
	return blockedResult(toolName, text, details);
}

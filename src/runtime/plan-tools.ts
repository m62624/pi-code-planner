import { planBranchName } from "../git/branches";
import type { GitRunner } from "../git/runner";
import { DEFAULT_INSTRUCTIONS } from "../instructions/defaults";
import { syncInstructionFiles } from "../instructions/manager";
import { createInstructionPaths } from "../instructions/paths";
import { initializeMemoryFiles } from "../memory/manager";
import { loadEffectivePlannerSettings } from "../settings/manager";
import type { WorktreeSettings } from "../settings/schema";
import type { PlannerFs } from "../storage/fs";
import { sanitizeIdPart } from "../storage/ids";
import {
	createPlanStoragePaths,
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
import { createPlanWorktree } from "../worktree/manager";
import {
	createCustomWorktreeLocation,
	createProjectLocalWorktreeLocation,
} from "../worktree/paths";
import { inspectPlannerGitReality } from "./git-state-sync";

export const PLANNER_PLAN_TOOL_NAMES = ["planner_create_plan"] as const;

export type PlannerPlanToolName = (typeof PLANNER_PLAN_TOOL_NAMES)[number];

export interface PlannerPlanToolExecutionInput {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerPlanToolName;
	params: unknown;
}

export interface PlannerPlanToolExecutionResult {
	status: "applied" | "blocked";
	toolName: PlannerPlanToolName;
	text: string;
	details: unknown;
}

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

async function createPlanTool(
	input: PlannerPlanToolExecutionInput,
): Promise<PlannerPlanToolExecutionResult> {
	const params = asObject(input.params);
	const planId = requiredPlanId(params);
	const title = requiredString(params, "title");
	const project = await ensureProjectRecord(input.fs, input.projectPaths);
	if (project.activePlanId) {
		return blocked(
			input.toolName,
			`Project already has an active planner plan: ${project.activePlanId}. Switch or finish the active plan before creating another one.`,
			{ project },
		);
	}

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
	const plan = createPlanRecord({ planId, title, status: "active" });
	const settings = await loadEffectivePlannerSettings({
		fs: input.fs,
		projectPaths: input.projectPaths,
	});
	const worktreeLocation = worktreeLocationForPlan({
		projectPaths: input.projectPaths,
		planId,
		worktree: settings.effective.worktree,
	});

	await syncInstructionFiles(
		input.fs,
		createInstructionPaths(input.projectPaths),
		DEFAULT_INSTRUCTIONS,
	);
	const worktree = await createPlanWorktree({
		fs: input.fs,
		git: input.git,
		projectPaths: input.projectPaths,
		worktreePath: worktreeLocation,
		branch: planBranch,
		fromRef: baseBranch,
	});
	const reality = await inspectPlannerGitReality({
		git: input.git,
		repoRoot: worktreeLocation,
	});
	const state = {
		...createInitialPlanState({
			baseBranch,
			planBranch,
			worktreePath: worktreeLocation,
		}),
		stage: "discovery",
		step: "read_project",
		stepStatus: "pending",
		currentBranch: reality.branch,
		lastCheckpointCommit: reality.headCommit,
	} as const;
	await initializePlanFiles(input.fs, planPaths, plan);
	await initializePlanState(input.fs, planPaths, state);
	const memoryPaths = await initializeMemoryFiles(input.fs, planPaths);
	await upsertProjectPlanSummary(input.fs, input.projectPaths, {
		planId,
		title,
		status: "active",
	});
	const nextProject = await setActivePlan(input.fs, input.projectPaths, planId);

	return applied(
		input.toolName,
		[
			"Planner plan created.",
			`Plan: ${planId}`,
			`Title: ${title}`,
			`Base branch: ${baseBranch}`,
			`Worktree: ${worktreeLocation}`,
			"Next: switch/open Pi in the planner worktree session, call planner_status, then start discovery/read_project.",
		].join("\n"),
		{
			project: nextProject,
			plan,
			state,
			planPaths,
			memoryPaths,
			worktree,
			settings,
		},
	);
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

function requiredPlanId(params: Record<string, unknown>): string {
	const raw = requiredString(params, "planId");
	const planId = sanitizeIdPart(raw);
	if (planId.length === 0) {
		throw new TypeError("Missing required string parameter: planId.");
	}
	return planId;
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

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function applied(
	toolName: PlannerPlanToolName,
	text: string,
	details: unknown,
): PlannerPlanToolExecutionResult {
	return { status: "applied", toolName, text, details };
}

function blocked(
	toolName: PlannerPlanToolName,
	text: string,
	details: unknown,
): PlannerPlanToolExecutionResult {
	return { status: "blocked", toolName, text, details };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

import { planBranchName } from "../git/branches";
import type { GitRunner } from "../git/runner";
import { DEFAULT_INSTRUCTIONS } from "../instructions/defaults";
import { syncInstructionFiles } from "../instructions/manager";
import { createInstructionPaths } from "../instructions/paths";
import { initializeMemoryFiles } from "../memory/manager";
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
	const state = createInitialPlanState({ baseBranch, planBranch });

	await syncInstructionFiles(
		input.fs,
		createInstructionPaths(input.projectPaths),
		DEFAULT_INSTRUCTIONS,
	);
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
			"Next: call planner_status, then follow init/check_project.",
		].join("\n"),
		{
			project: nextProject,
			plan,
			state,
			planPaths,
			memoryPaths,
		},
	);
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

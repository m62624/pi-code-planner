import {
	createAndSwitchExperimentBranch,
	createAndSwitchRefactorBranch,
	createAndSwitchTaskBranch,
	mergeRefactorToTask,
	mergeSelectedExperimentToTask,
	mergeTaskToPlan,
	selectExperiment,
} from "../git/planner-ops";
import type { GitRunner } from "../git/runner";
import type { PlannerWrapperTool } from "../guard/tool-policy";
import type { PlannerFs } from "../storage/fs";
import type { ProjectStoragePaths } from "../storage/paths";
import type { PlanStateRecord } from "../storage/schema";
import { savePlanState } from "../storage/state-store";
import {
	inspectPlannerGitReality,
	runSyncedPlannerGitMutation,
	syncStateAfterPlannerGitMutation,
} from "./git-state-sync";
import {
	checkPlannerOrchestratorToolAllowed,
	type PlannerOrchestratorResult,
	runPlannerOrchestrator,
} from "./orchestrator";

export const PLANNER_GIT_TOOL_NAMES = [
	"planner_git_inspect",
	"planner_git_init",
	"planner_git_commit",
	"planner_git_create_task_branch",
	"planner_git_create_experiment_branch",
	"planner_git_select_experiment",
	"planner_git_merge_selected_experiment",
	"planner_git_create_refactor_branch",
	"planner_git_merge_refactor_to_task",
	"planner_git_merge_task_to_plan",
] as const satisfies readonly PlannerWrapperTool[];

export type PlannerGitToolName = (typeof PLANNER_GIT_TOOL_NAMES)[number];

export interface PlannerGitToolExecutionInput {
	fs: PlannerFs;
	git: GitRunner;
	projectPaths: ProjectStoragePaths;
	toolName: PlannerGitToolName;
	params: unknown;
}

export interface PlannerGitToolExecutionResult {
	status: "applied" | "blocked";
	toolName: PlannerGitToolName;
	text: string;
	details: unknown;
}

interface ReadyGitContext {
	status: "ready";
	orchestrator: PlannerOrchestratorResult & {
		preflight: PlannerOrchestratorResult["preflight"] & {
			context: Extract<
				PlannerOrchestratorResult["preflight"]["context"],
				{ status: "ready" }
			>;
		};
	};
	state: PlanStateRecord;
	planId: string;
}

export async function executePlannerGitTool(
	input: PlannerGitToolExecutionInput,
): Promise<PlannerGitToolExecutionResult> {
	const orchestrator = await runPlannerOrchestrator(input);
	const ready = readyGitContext(orchestrator, input.toolName);
	if (ready.status === "blocked") {
		return ready.result;
	}

	try {
		switch (input.toolName) {
			case "planner_git_inspect":
				return await inspectGitTool(input, ready);
			case "planner_git_init":
				return await initGitTool(input);
			case "planner_git_commit":
				return await commitGitTool(input, ready);
			case "planner_git_create_task_branch":
				return await createTaskBranchTool(input, ready);
			case "planner_git_create_experiment_branch":
				return await createExperimentBranchTool(input, ready);
			case "planner_git_select_experiment":
				return await selectExperimentTool(input, ready);
			case "planner_git_merge_selected_experiment":
				return await mergeSelectedExperimentTool(input, ready);
			case "planner_git_create_refactor_branch":
				return await createRefactorBranchTool(input, ready);
			case "planner_git_merge_refactor_to_task":
				return await mergeRefactorTool(input, ready);
			case "planner_git_merge_task_to_plan":
				return await mergeTaskTool(input, ready);
		}
	} catch (error) {
		return blocked(input.toolName, errorMessage(error), { error });
	}
}

function readyGitContext(
	orchestrator: PlannerOrchestratorResult,
	toolName: PlannerGitToolName,
):
	| ReadyGitContext
	| {
			status: "blocked";
			result: PlannerGitToolExecutionResult;
	  } {
	if (orchestrator.preflight.context.status !== "ready") {
		return {
			status: "blocked",
			result: blocked(toolName, orchestrator.preflight.context.reason, {
				orchestrator,
			}),
		};
	}
	const policy = checkPlannerOrchestratorToolAllowed({
		orchestrator,
		toolName,
	});
	if (!policy.allow) {
		return {
			status: "blocked",
			result: blocked(
				toolName,
				policy.reason ?? `Planner git tool ${toolName} is blocked.`,
				{ orchestrator, policy },
			),
		};
	}
	return {
		status: "ready",
		orchestrator: orchestrator as ReadyGitContext["orchestrator"],
		state: orchestrator.preflight.context.state,
		planId: orchestrator.preflight.context.activePlanId,
	};
}

async function inspectGitTool(
	input: PlannerGitToolExecutionInput,
	ready: ReadyGitContext,
): Promise<PlannerGitToolExecutionResult> {
	const repoRoot = ready.state.worktreePath ?? input.projectPaths.projectRoot;
	const reality = await inspectPlannerGitReality({ git: input.git, repoRoot });
	return applied(
		input.toolName,
		[
			"Planner git inspection.",
			`Repo: ${repoRoot}`,
			`Branch: ${reality.branch}`,
			`HEAD: ${reality.headCommit}`,
			`Dirty: ${reality.isDirty ? "yes" : "no"}`,
			`Conflicts: ${reality.hasConflicts ? "yes" : "no"}`,
		].join("\n"),
		{ reality },
	);
}

async function initGitTool(
	input: PlannerGitToolExecutionInput,
): Promise<PlannerGitToolExecutionResult> {
	await input.git.init({ repoRoot: input.projectPaths.projectRoot });
	return applied(input.toolName, "Planner initialized git repository.", {
		repoRoot: input.projectPaths.projectRoot,
	});
}

async function commitGitTool(
	input: PlannerGitToolExecutionInput,
	ready: ReadyGitContext,
): Promise<PlannerGitToolExecutionResult> {
	const repoRoot = requireWorktreePath(ready.state);
	const message = requiredString(input.params, "message");
	const synced = await runSyncedPlannerGitMutation({
		git: input.git,
		state: ready.state,
		repoRoot,
		headChangeReason: "planner_commit",
		mutate: async ({ before }) => {
			if (!before.isDirty) {
				throw new Error(
					"Planner git commit is blocked because the worktree has no changes to commit.",
				);
			}
			await input.git.stageAll({ repoRoot });
			await input.git.commit({ repoRoot, message });
		},
	});
	await savePlanState(
		input.fs,
		ready.orchestrator.preflight.context.planPaths,
		synced.state,
	);
	return applied(
		input.toolName,
		"Planner git commit created. Memory update is required before normal flow continues.",
		synced,
	);
}

async function createTaskBranchTool(
	input: PlannerGitToolExecutionInput,
	ready: ReadyGitContext,
): Promise<PlannerGitToolExecutionResult> {
	const taskId = requiredString(input.params, "taskId");
	return await runStateChangingGitOperation({
		input,
		ready,
		headChangeReason: "planner_commit",
		text: `Planner task branch created for ${taskId}.`,
		operation: () =>
			createAndSwitchTaskBranch({
				git: input.git,
				state: ready.state,
				planId: ready.planId,
				taskId,
			}),
	});
}

async function createExperimentBranchTool(
	input: PlannerGitToolExecutionInput,
	ready: ReadyGitContext,
): Promise<PlannerGitToolExecutionResult> {
	const taskId =
		ready.state.activeTaskId ?? requiredString(input.params, "taskId");
	const attemptId = requiredString(input.params, "attemptId");
	return await runStateChangingGitOperation({
		input,
		ready,
		headChangeReason: "planner_commit",
		text: `Planner experiment branch created for ${attemptId}.`,
		operation: () =>
			createAndSwitchExperimentBranch({
				git: input.git,
				state: ready.state,
				planId: ready.planId,
				taskId,
				attemptId,
			}),
	});
}

async function selectExperimentTool(
	input: PlannerGitToolExecutionInput,
	ready: ReadyGitContext,
): Promise<PlannerGitToolExecutionResult> {
	const taskId =
		ready.state.activeTaskId ?? requiredString(input.params, "taskId");
	const attemptId = requiredString(input.params, "attemptId");
	const result = await selectExperiment({
		state: ready.state,
		planId: ready.planId,
		taskId,
		attemptId,
	});
	await savePlanState(
		input.fs,
		ready.orchestrator.preflight.context.planPaths,
		result.state,
	);
	return applied(input.toolName, `Planner selected experiment ${attemptId}.`, {
		state: result.state,
	});
}

async function mergeSelectedExperimentTool(
	input: PlannerGitToolExecutionInput,
	ready: ReadyGitContext,
): Promise<PlannerGitToolExecutionResult> {
	return await runStateChangingGitOperation({
		input,
		ready,
		headChangeReason: "planner_merge",
		text: "Planner merged selected experiment into task branch.",
		operation: () =>
			mergeSelectedExperimentToTask({
				git: input.git,
				state: ready.state,
				message: optionalMessage(
					input.params,
					"merge selected experiment into task",
				),
			}),
	});
}

async function createRefactorBranchTool(
	input: PlannerGitToolExecutionInput,
	ready: ReadyGitContext,
): Promise<PlannerGitToolExecutionResult> {
	const taskId =
		ready.state.activeTaskId ?? requiredString(input.params, "taskId");
	return await runStateChangingGitOperation({
		input,
		ready,
		headChangeReason: "planner_commit",
		text: "Planner refactor branch created.",
		operation: () =>
			createAndSwitchRefactorBranch({
				git: input.git,
				state: ready.state,
				planId: ready.planId,
				taskId,
			}),
	});
}

async function mergeRefactorTool(
	input: PlannerGitToolExecutionInput,
	ready: ReadyGitContext,
): Promise<PlannerGitToolExecutionResult> {
	const taskId =
		ready.state.activeTaskId ?? requiredString(input.params, "taskId");
	return await runStateChangingGitOperation({
		input,
		ready,
		headChangeReason: "planner_merge",
		text: "Planner merged refactor branch into task branch.",
		operation: () =>
			mergeRefactorToTask({
				git: input.git,
				state: ready.state,
				planId: ready.planId,
				taskId,
				message: optionalMessage(input.params, "merge refactor into task"),
			}),
	});
}

async function mergeTaskTool(
	input: PlannerGitToolExecutionInput,
	ready: ReadyGitContext,
): Promise<PlannerGitToolExecutionResult> {
	return await runStateChangingGitOperation({
		input,
		ready,
		headChangeReason: "planner_merge",
		text: "Planner merged task branch into plan branch.",
		operation: () =>
			mergeTaskToPlan({
				git: input.git,
				state: ready.state,
				message: optionalMessage(input.params, "merge task into plan"),
			}),
	});
}

async function runStateChangingGitOperation(input: {
	input: PlannerGitToolExecutionInput;
	ready: ReadyGitContext;
	headChangeReason: "planner_commit" | "planner_merge";
	text: string;
	operation: () => Promise<{ state: PlanStateRecord }>;
}): Promise<PlannerGitToolExecutionResult> {
	const repoRoot = requireWorktreePath(input.ready.state);
	const before = await inspectPlannerGitReality({
		git: input.input.git,
		repoRoot,
	});
	const result = await input.operation();
	const after = await inspectPlannerGitReality({
		git: input.input.git,
		repoRoot,
	});
	const state = syncStateAfterPlannerGitMutation({
		state: result.state,
		before,
		after,
		headChangeReason: input.headChangeReason,
	});
	await savePlanState(
		input.input.fs,
		input.ready.orchestrator.preflight.context.planPaths,
		state,
	);
	return applied(input.input.toolName, input.text, {
		before,
		after,
		state,
	});
}

function requireWorktreePath(state: PlanStateRecord): string {
	if (!state.worktreePath) {
		throw new Error("Plan state has no worktreePath.");
	}
	return state.worktreePath;
}

function requiredString(params: unknown, key: string): string {
	const value = asObject(params)[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new TypeError(`Missing required string parameter: ${key}.`);
	}
	return value;
}

function optionalMessage(params: unknown, fallback: string): string {
	const value = asObject(params).message;
	return typeof value === "string" && value.trim().length > 0
		? value
		: fallback;
}

function asObject(value: unknown): Record<string, unknown> {
	return value && typeof value === "object"
		? (value as Record<string, unknown>)
		: {};
}

function applied(
	toolName: PlannerGitToolName,
	text: string,
	details: unknown,
): PlannerGitToolExecutionResult {
	return { status: "applied", toolName, text, details };
}

function blocked(
	toolName: PlannerGitToolName,
	text: string,
	details: unknown,
): PlannerGitToolExecutionResult {
	return { status: "blocked", toolName, text, details };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : "Planner git tool failed.";
}

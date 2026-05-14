import type {
	AgentToolResult,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import type { GitCore } from "../git/core";
import { GitMutationRejected } from "../git/mutations";
import type { GitPreflightOperation } from "../git/preflight";

export type GitCoreResolver = (cwd: string) => GitCore;

function ok<T>(message: string, details: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text: message }],
		details,
	};
}

function fail<T>(message: string, details: T): AgentToolResult<T> {
	return {
		content: [{ type: "text", text: message }],
		details,
	};
}

async function withPreflight<TDetails>(
	ctx: ExtensionContext,
	getCore: GitCoreResolver,
	operation: GitPreflightOperation,
	run: (core: GitCore) => Promise<AgentToolResult<TDetails>>,
): Promise<AgentToolResult<TDetails | unknown>> {
	const core = getCore(ctx.cwd);
	const preflight = await core.preflight.check(operation);
	if (!preflight.allowed) {
		return fail(preflight.message, { preflight });
	}

	try {
		return await run(core);
	} catch (error) {
		if (error instanceof GitMutationRejected) {
			return fail(error.message, { decision: error.decision });
		}
		throw error;
	}
}

function tool<TParams extends TSchema, TDetails>(
	definition: Omit<
		ToolDefinition<TParams, TDetails>,
		"executionMode" | "renderShell"
	>,
): ToolDefinition<TParams, TDetails> {
	return {
		...definition,
		executionMode: "sequential",
		renderShell: "default",
	};
}

const emptySchema = Type.Object({});
const startPlanSchema = Type.Object({
	planId: Type.String({ description: "Stable planner plan id." }),
	startPoint: Type.Optional(
		Type.String({ description: "Optional git start point." }),
	),
});
const workItemSchema = Type.Object({
	workItemId: Type.String({ description: "Stable work item id." }),
	startPoint: Type.Optional(
		Type.String({ description: "Optional git start point." }),
	),
});
const experimentSchema = Type.Object({
	workItemId: Type.String({ description: "Stable work item id." }),
	attemptId: Type.String({ description: "Stable experiment attempt id." }),
	startPoint: Type.Optional(
		Type.String({ description: "Optional git start point." }),
	),
});
const commitSchema = Type.Object({
	message: Type.String({ description: "Commit message to create." }),
	stageAll: Type.Optional(
		Type.Boolean({ description: "Stage all changes first." }),
	),
});
const deleteChildSchema = Type.Object({
	workItemId: Type.String({ description: "Stable work item id." }),
	force: Type.Optional(Type.Boolean({ description: "Force delete branch." })),
});
const deleteExperimentSchema = Type.Object({
	workItemId: Type.String({ description: "Stable work item id." }),
	attemptId: Type.String({ description: "Stable experiment attempt id." }),
	force: Type.Optional(Type.Boolean({ description: "Force delete branch." })),
});
const hardResetSchema = Type.Object({
	confirm: Type.Boolean({
		description: "Must be true to allow destructive hard reset.",
	}),
});

export function createPlannerGitTools(
	getCore: GitCoreResolver,
): ToolDefinition[] {
	return [
		tool({
			name: "planner_initialize_repo",
			label: "planner git init",
			description:
				"Initialize git for the current project when planner requires it.",
			parameters: emptySchema,
			execute: (_id, _params, _signal, _onUpdate, ctx) =>
				withPreflight(ctx, getCore, "initialize_repo", async (core) => {
					const mutation = await core.mutations.initializeRepo();
					return ok("Git repository initialized.", mutation);
				}),
		}),
		tool({
			name: "planner_start_plan",
			label: "planner start plan",
			description:
				"Create and switch to the managed main branch for a planner plan.",
			parameters: startPlanSchema,
			execute: (
				_id,
				params: Static<typeof startPlanSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				withPreflight(ctx, getCore, "start_plan", async (core) => {
					const mutation = await core.mutations.createPlanBranch(params);
					return ok("Planner plan branch created.", mutation);
				}),
		}),
		tool({
			name: "planner_start_work_item",
			label: "planner start work item",
			description:
				"Create and switch to the managed child branch for a work item.",
			parameters: workItemSchema,
			execute: (
				_id,
				params: Static<typeof workItemSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				withPreflight(ctx, getCore, "start_work_item", async (core) => {
					const mutation = await core.mutations.createChildBranch(params);
					return ok("Planner work item branch created.", mutation);
				}),
		}),
		tool({
			name: "planner_start_experiment",
			label: "planner start experiment",
			description:
				"Create and switch to a managed experiment branch for a work item.",
			parameters: experimentSchema,
			execute: (
				_id,
				params: Static<typeof experimentSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				withPreflight(ctx, getCore, "start_work_item", async (core) => {
					const mutation = await core.mutations.createExperimentBranch(params);
					return ok("Planner experiment branch created.", mutation);
				}),
		}),
		tool({
			name: "planner_select_experiment",
			label: "planner select experiment",
			description:
				"Merge a selected managed experiment branch into its child branch.",
			parameters: experimentSchema,
			execute: (
				_id,
				params: Static<typeof experimentSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				withPreflight(ctx, getCore, "merge_branch", async (core) => {
					const mutation = await core.mutations.selectExperimentBranch(params);
					return ok("Planner experiment selected.", mutation);
				}),
		}),
		tool({
			name: "planner_finish_work_item",
			label: "planner finish work item",
			description:
				"Commit the current work item changes through planner state tracking.",
			parameters: commitSchema,
			execute: (
				_id,
				params: Static<typeof commitSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				withPreflight(ctx, getCore, "finish_work_item", async (core) => {
					const mutation = await core.mutations.commitWorkItem(params);
					return ok("Planner work item committed.", mutation);
				}),
		}),
		tool({
			name: "planner_delete_child_branch",
			label: "planner delete child",
			description: "Delete a registered managed child branch by work item id.",
			parameters: deleteChildSchema,
			execute: (
				_id,
				params: Static<typeof deleteChildSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				withPreflight(ctx, getCore, "delete_branch", async (core) => {
					const mutation = await core.mutations.deleteChildBranch(params);
					return ok("Planner child branch deleted.", mutation);
				}),
		}),
		tool({
			name: "planner_delete_experiment_branch",
			label: "planner delete experiment",
			description:
				"Delete a registered managed experiment branch by work item and attempt id.",
			parameters: deleteExperimentSchema,
			execute: (
				_id,
				params: Static<typeof deleteExperimentSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				withPreflight(ctx, getCore, "delete_branch", async (core) => {
					const mutation = await core.mutations.deleteExperimentBranch(params);
					return ok("Planner experiment branch deleted.", mutation);
				}),
		}),
		tool({
			name: "planner_accept_current_git_state",
			label: "planner accept git state",
			description:
				"Accept the current git branch and commit as the planner expected state.",
			parameters: emptySchema,
			execute: (_id, _params, _signal, _onUpdate, ctx) =>
				withPreflight(ctx, getCore, "recovery", async (core) => {
					const mutation = await core.mutations.acceptCurrentGitState();
					return ok("Planner accepted current git state.", mutation);
				}),
		}),
		tool({
			name: "planner_soft_reset_to_expected",
			label: "planner soft reset",
			description: "Soft reset to the commit stored as planner expected state.",
			parameters: emptySchema,
			execute: (_id, _params, _signal, _onUpdate, ctx) =>
				withPreflight(ctx, getCore, "recovery", async (core) => {
					const mutation = await core.mutations.softResetToExpected();
					return ok("Planner soft reset completed.", mutation);
				}),
		}),
		tool({
			name: "planner_hard_reset_to_expected",
			label: "planner hard reset",
			description: "Hard reset to the commit stored as planner expected state.",
			parameters: hardResetSchema,
			execute: (
				_id,
				params: Static<typeof hardResetSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				withPreflight(ctx, getCore, "recovery", async (core) => {
					if (params.confirm !== true) {
						throw new Error("Hard reset requires confirm=true.");
					}
					const mutation = await core.mutations.hardResetToExpected({
						confirm: true,
					});
					return ok("Planner hard reset completed.", mutation);
				}),
		}),
	];
}

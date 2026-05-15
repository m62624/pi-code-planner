import type {
	AgentToolResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import {
	type PlannerOrchestrator,
	PlannerOrchestratorBlockedByCompact,
} from "../orchestrator/planner-orchestrator";
import { WorkflowTransitionRejected } from "../workflow/manager";
import { PLAN_STAGES, WORK_ITEM_STAGES } from "../workflow/schema";

export type PlannerOrchestratorResolver = (cwd: string) => PlannerOrchestrator;

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

function runWorkflow<T>(
	run: () => T,
	successMessage: string,
): AgentToolResult<T | unknown> {
	try {
		return ok(successMessage, run());
	} catch (error) {
		if (error instanceof WorkflowTransitionRejected) {
			return fail(error.message, { decision: error.decision });
		}
		if (error instanceof PlannerOrchestratorBlockedByCompact) {
			return fail(error.message, { pendingCompact: error.pending });
		}
		throw error;
	}
}

function stringUnionSchema(values: readonly string[]) {
	return Type.Union(values.map((value) => Type.Literal(value)));
}

const createPlanSchema = Type.Object({
	title: Type.String({ description: "Human-readable plan title." }),
	planId: Type.Optional(
		Type.String({ description: "Stable planner plan id." }),
	),
});

const transitionPlanSchema = Type.Object({
	planId: Type.String({ description: "Stable planner plan id." }),
	stage: stringUnionSchema(PLAN_STAGES),
});

const createWorkItemSchema = Type.Object({
	planId: Type.String({ description: "Stable planner plan id." }),
	title: Type.String({ description: "Human-readable work item title." }),
	workItemId: Type.Optional(
		Type.String({ description: "Stable work item id." }),
	),
});

const transitionWorkItemSchema = Type.Object({
	planId: Type.String({ description: "Stable planner plan id." }),
	workItemId: Type.String({ description: "Stable work item id." }),
	stage: stringUnionSchema(WORK_ITEM_STAGES),
});

const requestDiscoveryCompactSchema = Type.Object({
	planId: Type.String({ description: "Stable planner plan id." }),
	customInstructions: Type.String({
		description: "Instructions passed to Pi compaction.",
	}),
	resumePrompt: Type.String({
		description:
			"Planner instruction delivered after discovery compaction completes.",
	}),
	attachToNextTurn: Type.Optional(Type.Boolean()),
	autoResume: Type.Optional(Type.Boolean()),
});

const completeDiscoveryCompactSchema = Type.Object({
	planId: Type.String({ description: "Stable planner plan id." }),
});

const requestWorkItemCompactSchema = Type.Object({
	planId: Type.String({ description: "Stable planner plan id." }),
	workItemId: Type.String({ description: "Stable work item id." }),
	customInstructions: Type.String({
		description: "Instructions passed to Pi compaction.",
	}),
	resumePrompt: Type.String({
		description:
			"Planner instruction delivered after work item compaction completes.",
	}),
	attachToNextTurn: Type.Optional(Type.Boolean()),
	autoResume: Type.Optional(Type.Boolean()),
});

const completeWorkItemCompactSchema = Type.Object({
	planId: Type.String({ description: "Stable planner plan id." }),
	workItemId: Type.String({ description: "Stable work item id." }),
});

export function createPlannerWorkflowTools(
	getOrchestrator: PlannerOrchestratorResolver,
): ToolDefinition[] {
	return [
		{
			name: "planner_create_plan",
			label: "planner create plan",
			description:
				"Create a persisted planner plan and activate planner state.",
			promptSnippet:
				"CALL to create a planner plan before discovery. Returns the persisted plan record.",
			parameters: createPlanSchema,
			executionMode: "sequential",
			renderShell: "default",
			execute: (
				_id,
				params: Static<typeof createPlanSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				Promise.resolve(
					runWorkflow(
						() => getOrchestrator(ctx.cwd).createPlan(params),
						"Planner plan created.",
					),
				),
		},
		{
			name: "planner_transition_plan",
			label: "planner transition plan",
			description: "Move a persisted plan to another legal workflow stage.",
			parameters: transitionPlanSchema,
			executionMode: "sequential",
			renderShell: "default",
			execute: (
				_id,
				params: Static<typeof transitionPlanSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				Promise.resolve(
					runWorkflow(
						() =>
							getOrchestrator(ctx.cwd).transitionPlan(
								params.planId,
								params.stage,
							),
						"Planner plan transitioned.",
					),
				),
		},
		{
			name: "planner_create_work_item",
			label: "planner create work item",
			description: "Create a persisted work item inside a planner plan.",
			parameters: createWorkItemSchema,
			executionMode: "sequential",
			renderShell: "default",
			execute: (
				_id,
				params: Static<typeof createWorkItemSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				Promise.resolve(
					runWorkflow(
						() =>
							getOrchestrator(ctx.cwd).createWorkItem(params.planId, {
								title: params.title,
								workItemId: params.workItemId,
							}),
						"Planner work item created.",
					),
				),
		},
		{
			name: "planner_transition_work_item",
			label: "planner transition work item",
			description:
				"Move a persisted work item to another legal workflow stage.",
			parameters: transitionWorkItemSchema,
			executionMode: "sequential",
			renderShell: "default",
			execute: (
				_id,
				params: Static<typeof transitionWorkItemSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				Promise.resolve(
					runWorkflow(
						() =>
							getOrchestrator(ctx.cwd).transitionWorkItem(
								params.planId,
								params.workItemId,
								params.stage,
							),
						"Planner work item transitioned.",
					),
				),
		},
		{
			name: "planner_request_discovery_compact",
			label: "planner discovery compact",
			description:
				"Enter discovery compact boundary and request planner-controlled compaction.",
			parameters: requestDiscoveryCompactSchema,
			executionMode: "sequential",
			renderShell: "default",
			execute: (
				_id,
				params: Static<typeof requestDiscoveryCompactSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				Promise.resolve(
					runWorkflow(
						() =>
							getOrchestrator(ctx.cwd).requestDiscoveryCompact(
								ctx,
								params.planId,
								{
									customInstructions: params.customInstructions,
									resumePrompt: params.resumePrompt,
									attachToNextTurn: params.attachToNextTurn,
									autoResume: params.autoResume,
								},
							),
						"Planner discovery compaction requested.",
					),
				),
		},
		{
			name: "planner_complete_discovery_compact",
			label: "planner complete discovery compact",
			description:
				"Complete discovery compact boundary after the resume instruction was consumed.",
			parameters: completeDiscoveryCompactSchema,
			executionMode: "sequential",
			renderShell: "default",
			execute: (
				_id,
				params: Static<typeof completeDiscoveryCompactSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				Promise.resolve(
					runWorkflow(
						() =>
							getOrchestrator(ctx.cwd).completeDiscoveryCompact(params.planId),
						"Planner discovery compact boundary completed.",
					),
				),
		},
		{
			name: "planner_request_work_item_compact",
			label: "planner work item compact",
			description:
				"Enter work item compact boundary and request planner-controlled compaction.",
			parameters: requestWorkItemCompactSchema,
			executionMode: "sequential",
			renderShell: "default",
			execute: (
				_id,
				params: Static<typeof requestWorkItemCompactSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				Promise.resolve(
					runWorkflow(
						() =>
							getOrchestrator(ctx.cwd).requestWorkItemCompact(
								ctx,
								params.planId,
								params,
							),
						"Planner work item compaction requested.",
					),
				),
		},
		{
			name: "planner_complete_work_item_compact",
			label: "planner complete work item compact",
			description:
				"Complete work item compact boundary after the resume instruction was consumed.",
			parameters: completeWorkItemCompactSchema,
			executionMode: "sequential",
			renderShell: "default",
			execute: (
				_id,
				params: Static<typeof completeWorkItemCompactSchema>,
				_signal,
				_onUpdate,
				ctx,
			) =>
				Promise.resolve(
					runWorkflow(
						() =>
							getOrchestrator(ctx.cwd).completeWorkItemCompact(
								params.planId,
								params.workItemId,
							),
						"Planner work item compact boundary completed.",
					),
				),
		},
	];
}

import type {
	AgentToolResult,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { checkMemoryPolicy } from "../memory/policy";
import type { DirtyMemoryState } from "../memory/schema";
import {
	type PlannerOrchestrator,
	PlannerOrchestratorBlockedByCompact,
} from "../orchestrator/planner-orchestrator";
import type { AssemblePlannerPromptResult } from "../prompts/assembler";
import { WorkflowTransitionRejected } from "../workflow/manager";
import { PLAN_STAGES, WORK_ITEM_STAGES } from "../workflow/schema";

export type PlannerOrchestratorResolver = (cwd: string) => PlannerOrchestrator;
export type DirtyMemoryResolver = (cwd: string) => DirtyMemoryState;

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

export interface PlannerWorkflowToolDetails<T> {
	result: T;
	nextPrompt: AssemblePlannerPromptResult | null;
}

function textWithNextPrompt(
	message: string,
	nextPrompt: AssemblePlannerPromptResult | null,
): string {
	if (!nextPrompt) return message;
	return `${message}\n\nNEXT PLANNER INSTRUCTION\n${nextPrompt.prompt}`;
}

function okWithPrompt<T>(
	successMessage: string,
	result: T,
	nextPrompt: AssemblePlannerPromptResult | null,
): AgentToolResult<PlannerWorkflowToolDetails<T>> {
	return ok(textWithNextPrompt(successMessage, nextPrompt), {
		result,
		nextPrompt,
	});
}

function runWorkflow<T>(
	run: () => { result: T; nextPrompt: AssemblePlannerPromptResult | null },
	successMessage: string,
): AgentToolResult<PlannerWorkflowToolDetails<T> | unknown> {
	try {
		const output = run();
		return okWithPrompt(successMessage, output.result, output.nextPrompt);
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

function memoryPolicyFailure(
	cwd: string,
	getDirtyMemory: DirtyMemoryResolver | undefined,
	operation: "request_compact" | "transition_from_signature_refresh",
): AgentToolResult<unknown> | null {
	if (!getDirtyMemory) return null;
	const memoryPolicy = checkMemoryPolicy({
		operation,
		dirty: getDirtyMemory(cwd),
	});
	if (memoryPolicy.kind === "allow") return null;
	return fail(memoryPolicy.message, { memoryPolicy });
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

const WORKFLOW_PROMPT_GUIDELINES = [
	"Use planner_create_plan before planner discovery work.",
	"Use planner_transition_plan and planner_transition_work_item only for legal planner stage transitions.",
	"Use planner_request_discovery_compact and planner_request_work_item_compact only at compact boundary stages.",
	"After planner workflow tools return NEXT PLANNER INSTRUCTION, follow that instruction before moving to unrelated work.",
];

export function createPlannerWorkflowTools(
	getOrchestrator: PlannerOrchestratorResolver,
	getDirtyMemory?: DirtyMemoryResolver,
): ToolDefinition[] {
	return [
		{
			name: "planner_create_plan",
			label: "planner create plan",
			description:
				"Create a persisted planner plan and activate planner state.",
			promptSnippet:
				"CALL to create a planner plan before discovery. Returns the persisted plan record.",
			promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
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
					runWorkflow(() => {
						const orchestrator = getOrchestrator(ctx.cwd);
						const result = orchestrator.createPlan(params);
						return {
							result,
							nextPrompt: orchestrator.buildPlanStagePrompt(result.planId),
						};
					}, "Planner plan created."),
				),
		},
		{
			name: "planner_transition_plan",
			label: "planner transition plan",
			description: "Move a persisted plan to another legal workflow stage.",
			promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
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
					runWorkflow(() => {
						const orchestrator = getOrchestrator(ctx.cwd);
						const result = orchestrator.transitionPlan(
							params.planId,
							params.stage,
						);
						return {
							result,
							nextPrompt: orchestrator.buildPlanStagePrompt(
								result.current.planId,
							),
						};
					}, "Planner plan transitioned."),
				),
		},
		{
			name: "planner_create_work_item",
			label: "planner create work item",
			description: "Create a persisted work item inside a planner plan.",
			promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
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
					runWorkflow(() => {
						const orchestrator = getOrchestrator(ctx.cwd);
						const result = orchestrator.createWorkItem(params.planId, {
							title: params.title,
							workItemId: params.workItemId,
						});
						return {
							result,
							nextPrompt: orchestrator.buildWorkItemStagePrompt(
								params.planId,
								result.workItemId,
							),
						};
					}, "Planner work item created."),
				),
		},
		{
			name: "planner_transition_work_item",
			label: "planner transition work item",
			description:
				"Move a persisted work item to another legal workflow stage.",
			promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
			parameters: transitionWorkItemSchema,
			executionMode: "sequential",
			renderShell: "default",
			execute: (
				_id,
				params: Static<typeof transitionWorkItemSchema>,
				_signal,
				_onUpdate,
				ctx,
			) => {
				if (params.stage === "work_item_compact_required") {
					const failure = memoryPolicyFailure(
						ctx.cwd,
						getDirtyMemory,
						"transition_from_signature_refresh",
					);
					if (failure) return Promise.resolve(failure);
				}
				return Promise.resolve(
					runWorkflow(() => {
						const orchestrator = getOrchestrator(ctx.cwd);
						const result = orchestrator.transitionWorkItem(
							params.planId,
							params.workItemId,
							params.stage,
						);
						return {
							result,
							nextPrompt: orchestrator.buildWorkItemStagePrompt(
								params.planId,
								result.current.workItemId,
							),
						};
					}, "Planner work item transitioned."),
				);
			},
		},
		{
			name: "planner_request_discovery_compact",
			label: "planner discovery compact",
			description:
				"Enter discovery compact boundary and request planner-controlled compaction.",
			promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
			parameters: requestDiscoveryCompactSchema,
			executionMode: "sequential",
			renderShell: "default",
			execute: (
				_id,
				params: Static<typeof requestDiscoveryCompactSchema>,
				_signal,
				_onUpdate,
				ctx,
			) => {
				const failure = memoryPolicyFailure(
					ctx.cwd,
					getDirtyMemory,
					"request_compact",
				);
				if (failure) return Promise.resolve(failure);
				return Promise.resolve(
					runWorkflow(() => {
						const orchestrator = getOrchestrator(ctx.cwd);
						const result = orchestrator.requestDiscoveryCompact(
							ctx,
							params.planId,
							{
								customInstructions: params.customInstructions,
								resumePrompt: params.resumePrompt,
								attachToNextTurn: params.attachToNextTurn,
								autoResume: params.autoResume,
							},
						);
						return {
							result,
							nextPrompt: orchestrator.buildPlanStagePrompt(params.planId),
						};
					}, "Planner discovery compaction requested."),
				);
			},
		},
		{
			name: "planner_complete_discovery_compact",
			label: "planner complete discovery compact",
			description:
				"Complete discovery compact boundary after the resume instruction was consumed.",
			promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
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
					runWorkflow(() => {
						const orchestrator = getOrchestrator(ctx.cwd);
						const result = orchestrator.completeDiscoveryCompact(params.planId);
						return {
							result,
							nextPrompt: orchestrator.buildPlanStagePrompt(
								result.current.planId,
							),
						};
					}, "Planner discovery compact boundary completed."),
				),
		},
		{
			name: "planner_request_work_item_compact",
			label: "planner work item compact",
			description:
				"Enter work item compact boundary and request planner-controlled compaction.",
			promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
			parameters: requestWorkItemCompactSchema,
			executionMode: "sequential",
			renderShell: "default",
			execute: (
				_id,
				params: Static<typeof requestWorkItemCompactSchema>,
				_signal,
				_onUpdate,
				ctx,
			) => {
				const failure = memoryPolicyFailure(
					ctx.cwd,
					getDirtyMemory,
					"request_compact",
				);
				if (failure) return Promise.resolve(failure);
				return Promise.resolve(
					runWorkflow(() => {
						const orchestrator = getOrchestrator(ctx.cwd);
						const result = orchestrator.requestWorkItemCompact(
							ctx,
							params.planId,
							params,
						);
						return {
							result,
							nextPrompt: orchestrator.buildWorkItemStagePrompt(
								params.planId,
								params.workItemId,
							),
						};
					}, "Planner work item compaction requested."),
				);
			},
		},
		{
			name: "planner_complete_work_item_compact",
			label: "planner complete work item compact",
			description:
				"Complete work item compact boundary after the resume instruction was consumed.",
			promptGuidelines: WORKFLOW_PROMPT_GUIDELINES,
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
					runWorkflow(() => {
						const orchestrator = getOrchestrator(ctx.cwd);
						const result = orchestrator.completeWorkItemCompact(
							params.planId,
							params.workItemId,
						);
						return {
							result,
							nextPrompt: orchestrator.buildWorkItemStagePrompt(
								params.planId,
								result.current.workItemId,
							),
						};
					}, "Planner work item compact boundary completed."),
				),
		},
	];
}

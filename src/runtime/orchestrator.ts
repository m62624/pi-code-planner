import type { PlannerWrapperTool } from "../guard/tool-policy";
import type { PlannerFs } from "../storage/fs";
import {
	decidePlannerLifecycleNext,
	type PlannerLifecycleDecision,
} from "./lifecycle";
import {
	checkPlannerWrapperToolForLifecycle,
	filterPlannerWrapperToolsForLifecycle,
} from "./orchestrator-gate";
import {
	checkPlannerPreflightToolAllowed,
	type PlannerPreflightResult,
	runPlannerPreflight,
} from "./preflight";
import {
	getPlannerStageStepBehavior,
	type PlannerStageStepBehavior,
} from "./stage-behavior";
import {
	getAllowedPlannerStateTransitionTypes,
	type PlannerStateTransitionType,
} from "./state-transition";
import { buildPlannerStatusText } from "./status";
import type { PlannerToolContext } from "./tool-context";
import type { PlannerWorkflowToolName } from "./workflow-tools";

export type PlannerManagedToolName =
	| PlannerWrapperTool
	| PlannerWorkflowToolName;

export type PlannerOrchestratorNextAction =
	| {
			kind: "none";
			message: string;
	  }
	| {
			kind: "tool";
			toolName: PlannerManagedToolName;
			transition: PlannerStateTransitionType | null;
			message: string;
	  }
	| {
			kind: "user_decision";
			toolName: PlannerManagedToolName | null;
			message: string;
	  };

export type PlannerOrchestratorInput = PlannerToolContext;

export interface PlannerOrchestratorResult {
	preflight: PlannerPreflightResult;
	lifecycle: PlannerLifecycleDecision;
	behavior: PlannerStageStepBehavior | null;
	statusText: string;
	nextAction: PlannerOrchestratorNextAction;
	allowedWrapperTools: readonly PlannerWrapperTool[];
	allowedWorkflowTools: readonly PlannerWorkflowToolName[];
	allowedTools: readonly PlannerManagedToolName[];
	allowedTransitions: readonly PlannerStateTransitionType[];
}

export interface PlannerOrchestratorToolDecision {
	allow: boolean;
	toolName: PlannerManagedToolName;
	reason: string | null;
	nextAction: PlannerOrchestratorNextAction;
	allowedTools: readonly PlannerManagedToolName[];
	allowedTransitions: readonly PlannerStateTransitionType[];
}

const WORKFLOW_TOOL_TRANSITIONS = {
	planner_start_step: "start_step",
	planner_finish_step: "finish_step",
	planner_advance_step: "advance_step",
	planner_fail_step: "fail_step",
	planner_block_step: "block_step",
	planner_retry_step: "retry_step",
	planner_request_compact: "request_compact",
	planner_complete_compact: "complete_compact",
	planner_enter_recovery: "enter_recovery",
	planner_resume_after_recovery: "resume_after_recovery",
} as const satisfies Record<
	PlannerWorkflowToolName,
	PlannerStateTransitionType
>;

export async function runPlannerOrchestrator(
	input: PlannerOrchestratorInput,
): Promise<PlannerOrchestratorResult> {
	const preflight = await runPlannerPreflight(input);
	return await buildPlannerOrchestrator({
		fs: input.fs,
		preflight,
	});
}

export async function buildPlannerOrchestrator(input: {
	fs: PlannerFs;
	preflight: PlannerPreflightResult;
}): Promise<PlannerOrchestratorResult> {
	const lifecycle = decidePlannerLifecycleNext(input.preflight);
	const behavior =
		input.preflight.context.status === "ready"
			? getPlannerStageStepBehavior(input.preflight.context.state)
			: null;
	const allowedTransitions = getAllowedPlannerStateTransitionTypes(
		input.preflight,
	);
	const allowedWorkflowTools =
		getAllowedWorkflowToolsForTransitions(allowedTransitions);
	const allowedWrapperTools = filterPlannerWrapperToolsForLifecycle({
		preflight: input.preflight,
		lifecycle,
		behavior,
		tools: input.preflight.decision.allowedTools,
	});
	const allowedTools = uniqueTools([
		...allowedWrapperTools,
		...allowedWorkflowTools,
	]);
	return {
		preflight: input.preflight,
		lifecycle,
		behavior,
		statusText: await buildPlannerStatusText({
			fs: input.fs,
			preflight: input.preflight,
		}),
		nextAction: buildNextAction(lifecycle),
		allowedWrapperTools,
		allowedWorkflowTools,
		allowedTools,
		allowedTransitions,
	};
}

export function checkPlannerOrchestratorToolAllowed(input: {
	orchestrator: PlannerOrchestratorResult;
	toolName: PlannerManagedToolName;
}): PlannerOrchestratorToolDecision {
	const workflowTransition = getWorkflowToolTransition(input.toolName);
	if (workflowTransition) {
		const allow =
			input.orchestrator.allowedTransitions.includes(workflowTransition);
		return {
			allow,
			toolName: input.toolName,
			reason: allow
				? null
				: buildBlockedToolReason({
						orchestrator: input.orchestrator,
						toolName: input.toolName,
						transition: workflowTransition,
					}),
			nextAction: input.orchestrator.nextAction,
			allowedTools: input.orchestrator.allowedTools,
			allowedTransitions: input.orchestrator.allowedTransitions,
		};
	}

	const policy = checkPlannerPreflightToolAllowed({
		preflight: input.orchestrator.preflight,
		tool: input.toolName as PlannerWrapperTool,
	});
	const lifecycleGate = policy.allow
		? checkPlannerWrapperToolForLifecycle({
				preflight: input.orchestrator.preflight,
				lifecycle: input.orchestrator.lifecycle,
				behavior: input.orchestrator.behavior,
				tool: input.toolName as PlannerWrapperTool,
			})
		: null;
	return {
		allow: policy.allow && (lifecycleGate?.allow ?? true),
		toolName: input.toolName,
		reason:
			policy.reason ??
			lifecycleGate?.reason ??
			(policy.allow && (lifecycleGate?.allow ?? true)
				? null
				: buildBlockedToolReason({
						orchestrator: input.orchestrator,
						toolName: input.toolName,
						transition: null,
					})),
		nextAction: input.orchestrator.nextAction,
		allowedTools: input.orchestrator.allowedTools,
		allowedTransitions: input.orchestrator.allowedTransitions,
	};
}

function buildNextAction(
	lifecycle: PlannerLifecycleDecision,
): PlannerOrchestratorNextAction {
	if (lifecycle.action === "no_active_plan") {
		return {
			kind: "none",
			message: lifecycle.modelMessage,
		};
	}

	if (lifecycle.action === "ask_user_decision") {
		return {
			kind: "user_decision",
			toolName: lifecycle.requiredTool,
			message: lifecycle.modelMessage,
		};
	}

	if (lifecycle.requiredTool) {
		return {
			kind: "tool",
			toolName: lifecycle.requiredTool,
			transition: lifecycle.requiredTransition,
			message: lifecycle.modelMessage,
		};
	}

	return {
		kind: "none",
		message: lifecycle.modelMessage,
	};
}

function getAllowedWorkflowToolsForTransitions(
	transitions: readonly PlannerStateTransitionType[],
): PlannerWorkflowToolName[] {
	const transitionSet = new Set(transitions);
	return Object.entries(WORKFLOW_TOOL_TRANSITIONS)
		.filter(([, transition]) => transitionSet.has(transition))
		.map(([toolName]) => toolName as PlannerWorkflowToolName);
}

function getWorkflowToolTransition(
	toolName: PlannerManagedToolName,
): PlannerStateTransitionType | null {
	if (isWorkflowToolName(toolName)) {
		return WORKFLOW_TOOL_TRANSITIONS[toolName];
	}
	return null;
}

function isWorkflowToolName(
	toolName: PlannerManagedToolName,
): toolName is PlannerWorkflowToolName {
	return Object.hasOwn(WORKFLOW_TOOL_TRANSITIONS, toolName);
}

function buildBlockedToolReason(input: {
	orchestrator: PlannerOrchestratorResult;
	toolName: PlannerManagedToolName;
	transition: PlannerStateTransitionType | null;
}): string {
	return [
		`Planner tool ${input.toolName} is blocked by lifecycle orchestrator.`,
		input.transition
			? `Requested transition: ${input.transition}.`
			: "Requested wrapper is not allowed by runtime preflight.",
		`Runtime action: ${input.orchestrator.preflight.decision.action}.`,
		`Lifecycle action: ${input.orchestrator.lifecycle.action}.`,
		`Next required action: ${formatNextAction(input.orchestrator.nextAction)}.`,
		input.orchestrator.lifecycle.modelMessage
			? `Guidance: ${input.orchestrator.lifecycle.modelMessage}`
			: "",
		`Allowed tools: ${input.orchestrator.allowedTools.join(", ") || "(none)"}.`,
		`Allowed transitions: ${input.orchestrator.allowedTransitions.join(", ") || "(none)"}.`,
	]
		.filter(Boolean)
		.join("\n");
}

function formatNextAction(action: PlannerOrchestratorNextAction): string {
	switch (action.kind) {
		case "none":
			return action.message;
		case "tool":
			return `${action.toolName}${action.transition ? ` (${action.transition})` : ""}`;
		case "user_decision":
			return action.toolName
				? `${action.toolName}: ${action.message}`
				: action.message;
	}
}

function uniqueTools(
	tools: readonly PlannerManagedToolName[],
): readonly PlannerManagedToolName[] {
	return Array.from(new Set(tools));
}

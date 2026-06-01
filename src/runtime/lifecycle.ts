import type { PlannerWrapperTool } from "../guard/tool-policy";
import type { InstructionKey } from "../instructions/schema";
import type { PlannerStage, PlannerStep, StepStatus } from "../storage/schema";
import type { PlannerRuntimeAction } from "./planner-runtime";
import type { PlannerPreflightResult } from "./preflight";
import { isPlannerCompactEnabled } from "./state-machine";
import {
	getAllowedPlannerStateTransitionTypes,
	type PlannerStateTransitionType,
} from "./state-transition";
import type { PlannerWorkflowToolName } from "./workflow-tools";

export type PlannerLifecycleAction =
	| "no_active_plan"
	| "inspect_recovery"
	| "ask_user_decision"
	| "inspect_memory"
	| "write_memory"
	| "sync_memory_checkpoint"
	| "compact_pending"
	| "draft_goal"
	| "await_goal_decision"
	| "start_step"
	| "request_compact"
	| "finish_step"
	| "advance_step"
	| "retry_step"
	| "blocked_step";

export interface PlannerLifecycleDecision {
	action: PlannerLifecycleAction;
	runtimeAction: PlannerRuntimeAction;
	stage: PlannerStage | null;
	step: PlannerStep | null;
	stepStatus: StepStatus | null;
	requiredTool: PlannerWrapperTool | PlannerWorkflowToolName | null;
	requiredTransition: PlannerStateTransitionType | null;
	allowedTools: readonly PlannerWrapperTool[];
	allowedTransitions: readonly PlannerStateTransitionType[];
	instructionKeys: readonly InstructionKey[];
	reason: string;
	modelMessage: string;
}

export function decidePlannerLifecycleNext(
	preflight: PlannerPreflightResult,
): PlannerLifecycleDecision {
	const allowedTransitions = getAllowedPlannerStateTransitionTypes(preflight);
	const base = baseDecision(preflight, allowedTransitions);

	switch (preflight.decision.action) {
		case "no_active_plan":
			return {
				...base,
				action: "no_active_plan",
				requiredTool: null,
				requiredTransition: null,
				reason: preflight.decision.reason ?? "No active planner plan.",
				modelMessage:
					"No planner plan is active. Do not use planner workflow tools unless the user asks to create or switch a plan.",
			};
		case "require_recovery":
			return {
				...base,
				action: "inspect_recovery",
				requiredTool: "planner_recovery_inspect",
				requiredTransition: null,
				reason: preflight.decision.reason ?? "Planner recovery is required.",
				modelMessage:
					"Call planner_recovery_inspect. Do not edit files, switch branches, run raw git, or continue normal flow.",
			};
		case "require_user_decision":
			return {
				...base,
				action: "ask_user_decision",
				requiredTool: "planner_recovery_inspect",
				requiredTransition: null,
				reason:
					preflight.decision.reason ??
					"Planner is waiting for a user decision.",
				modelMessage:
					"Ask the user for the required decision. Use planner_recovery_inspect if you need the exact recovery report before asking.",
			};
		case "require_memory_update":
			return memoryDecision(preflight, base);
		case "require_compact":
			return {
				...base,
				action: "compact_pending",
				requiredTool: "planner_complete_compact",
				requiredTransition: "complete_compact",
				reason: preflight.decision.reason ?? "Planner compact is pending.",
				modelMessage:
					"Wait for the Pi compact boundary to finish, then call planner_complete_compact and call planner_status again.",
			};
		case "allow_stage_machine":
			return stateMachineDecision(preflight, base, allowedTransitions);
	}
}

function memoryDecision(
	preflight: PlannerPreflightResult,
	base: PlannerLifecycleDecision,
): PlannerLifecycleDecision {
	if (preflight.gitReality?.isDirty) {
		return {
			...base,
			action: "inspect_recovery",
			requiredTool: "planner_recovery_inspect",
			requiredTransition: null,
			reason: "Memory checkpoint cannot sync while the worktree is dirty.",
			modelMessage:
				"Call planner_recovery_inspect and ask the user before resolving dirty worktree at a memory checkpoint boundary.",
		};
	}
	if (!preflight.memoryGate) {
		return {
			...base,
			action: "inspect_memory",
			requiredTool: "planner_memory_inspect",
			requiredTransition: null,
			reason: preflight.decision.reason ?? "Memory update is required.",
			modelMessage:
				"Call planner_memory_inspect to get the exact stale files, symbols, relations, and effect checks.",
		};
	}
	if (preflight.memoryGate.clean) {
		return {
			...base,
			action: "sync_memory_checkpoint",
			requiredTool: "planner_memory_sync_checkpoint",
			requiredTransition: null,
			reason: "Memory is fresh and checkpoint can be synced.",
			modelMessage:
				"Call planner_memory_sync_checkpoint. Do not continue the stage until checkpoint sync clears requiresMemoryUpdate.",
		};
	}
	return {
		...base,
		action: "write_memory",
		requiredTool: "planner_memory_scan_project",
		requiredTransition: null,
		reason: preflight.memoryGate.instruction,
		modelMessage:
			"Call planner_memory_scan_project to build a refresh queue. Process exactly one changed file at a time through next_file, read_chunk, upsert_active_file, symbol batches, verify_active_file, and complete_active_file. Then refresh evidence-backed relations, verify memory, and sync checkpoint.",
	};
}

function stateMachineDecision(
	preflight: PlannerPreflightResult,
	base: PlannerLifecycleDecision,
	allowedTransitions: readonly PlannerStateTransitionType[],
): PlannerLifecycleDecision {
	if (preflight.context.status !== "ready") {
		return {
			...base,
			action: "blocked_step",
			requiredTool: "planner_status",
			requiredTransition: null,
			reason: preflight.context.reason,
			modelMessage:
				"Active planner context is not ready. Call planner_status after creating or switching a plan.",
		};
	}

	const state = preflight.context.state;
	if (
		state.stage === "intake" &&
		state.step === "draft_goal" &&
		state.stepStatus === "running"
	) {
		return {
			...base,
			action: "draft_goal",
			requiredTool: "planner_goal_submit",
			requiredTransition: null,
			reason: "Draft the normalized user goal before discovery.",
			modelMessage:
				"Read request.md, write goal.md in your own words, then call planner_goal_submit. Do not inspect project source. Evidence-based clarification questions belong after discovery.",
		};
	}
	if (
		state.stage === "intake" &&
		state.step === "await_goal_approval" &&
		state.stepStatus === "running"
	) {
		return {
			...base,
			action: "await_goal_decision",
			requiredTool: "planner_goal_decide",
			requiredTransition: null,
			reason: "Wait for explicit user approval or revision feedback.",
			modelMessage:
				"Show the user goal.md and ask for explicit approval. Call planner_goal_decide only after the user answers approve or revise.",
		};
	}
	if (
		state.stage === "discovery" &&
		state.step === "write_questions" &&
		state.stepStatus === "running" &&
		!state.questionsResolved
	) {
		return {
			...base,
			action: "finish_step",
			requiredTool: state.questionsSubmitted
				? "planner_questions_resolve"
				: "planner_questions_submit",
			requiredTransition: null,
			reason: state.questionsSubmitted
				? "Discovery questions were submitted and require explicit user answers."
				: "Discovery questions must be submitted before planning.",
			modelMessage: state.questionsSubmitted
				? "Show the submitted discovery questions to the user verbatim. Wait for explicit answers, then call planner_questions_resolve. Do not continue to planning yet."
				: "Call planner_questions_submit with evidence-based questions and assumptions. Use hasOpenQuestions=false only when the artifact explicitly states that no unresolved questions remain.",
		};
	}
	switch (state.stepStatus) {
		case "pending":
			return transitionDecision({
				base,
				action: "start_step",
				transition: "start_step",
				tool: "planner_start_step",
				allowedTransitions,
				reason: `Planner step is pending: ${state.stage}/${state.step}.`,
				modelMessage:
					"Call planner_start_step. After it starts, follow the current step rule and instruction files.",
			});
		case "running":
			return state.step.startsWith("compact_") && isPlannerCompactEnabled(state)
				? transitionDecision({
						base,
						action: "request_compact",
						transition: "request_compact",
						tool: "planner_request_compact",
						allowedTransitions,
						reason: `Compact step is running: ${state.stage}/${state.step}.`,
						modelMessage:
							"Prepare the compact boundary summary, then call planner_request_compact.",
					})
				: transitionDecision({
						base,
						action: "finish_step",
						transition: "finish_step",
						tool: "planner_finish_step",
						allowedTransitions,
						reason: `Planner step is running: ${state.stage}/${state.step}.`,
						modelMessage: state.step.startsWith("compact_")
							? "This compact boundary is disabled in state.json. Call planner_finish_step to skip the real Pi compact while preserving the state-machine checkpoint."
							: "Finish the current step only after its exit condition is true. Then call planner_finish_step. The next persisted step opens atomically.",
					});
		case "completed":
			return transitionDecision({
				base,
				action: "advance_step",
				transition: "advance_step",
				tool: "planner_advance_step",
				allowedTransitions,
				reason: `Planner step is completed: ${state.stage}/${state.step}.`,
				modelMessage:
					"Call planner_advance_step. Do not repeat the completed step.",
			});
		case "failed":
			return transitionDecision({
				base,
				action: "retry_step",
				transition: "retry_step",
				tool: "planner_retry_step",
				allowedTransitions,
				reason: state.blockedReason ?? "Planner step failed.",
				modelMessage:
					"Fix or acknowledge the failure cause, then call planner_retry_step to retry the same step.",
			});
		case "blocked":
			return {
				...base,
				action: state.requiresUserDecision ? "ask_user_decision" : "retry_step",
				requiredTool: state.requiresUserDecision
					? "planner_recovery_inspect"
					: "planner_retry_step",
				requiredTransition: state.requiresUserDecision ? null : "retry_step",
				reason: state.blockedReason ?? "Planner step is blocked.",
				modelMessage: state.requiresUserDecision
					? "Ask the user for the required decision. Do not continue normal flow."
					: "Resolve the blocker, then call planner_retry_step if retry_step is still allowed.",
			};
	}
}

function transitionDecision(input: {
	base: PlannerLifecycleDecision;
	action: PlannerLifecycleAction;
	transition: PlannerStateTransitionType;
	tool: PlannerWorkflowToolName;
	allowedTransitions: readonly PlannerStateTransitionType[];
	reason: string;
	modelMessage: string;
}): PlannerLifecycleDecision {
	if (!input.allowedTransitions.includes(input.transition)) {
		return {
			...input.base,
			action: "blocked_step",
			requiredTool: "planner_status",
			requiredTransition: null,
			reason: `Transition ${input.transition} is not currently allowed.`,
			modelMessage:
				"Call planner_status and follow the runtime gate before attempting another transition.",
		};
	}
	return {
		...input.base,
		action: input.action,
		requiredTool: input.tool,
		requiredTransition: input.transition,
		reason: input.reason,
		modelMessage: input.modelMessage,
	};
}

function baseDecision(
	preflight: PlannerPreflightResult,
	allowedTransitions: readonly PlannerStateTransitionType[],
): PlannerLifecycleDecision {
	const state =
		preflight.context.status === "ready" ? preflight.context.state : null;
	return {
		action: "blocked_step",
		runtimeAction: preflight.decision.action,
		stage: state?.stage ?? null,
		step: state?.step ?? null,
		stepStatus: state?.stepStatus ?? null,
		requiredTool: null,
		requiredTransition: null,
		allowedTools: preflight.decision.allowedTools,
		allowedTransitions,
		instructionKeys: preflight.instructions?.keys ?? [],
		reason: preflight.decision.reason ?? "",
		modelMessage: "Call planner_status and follow the reported gate.",
	};
}

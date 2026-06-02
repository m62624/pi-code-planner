import type { PlannerWrapperTool } from "../guard/tool-policy";
import type { PlannerFs } from "../storage/fs";
import type { PlanStateRecord } from "../storage/schema";
import { savePlanState } from "../storage/state-store";
import type { PlannerPreflightResult } from "./preflight";
import { checkPlannerPreflightToolAllowed } from "./preflight";
import {
	advancePlannerStep,
	blockPlannerStep,
	completePlannerCompact,
	enterPlannerRecovery,
	failPlannerStep,
	finishAndStartPlannerStep,
	finishPlannerStep,
	isPlannerCompactEnabled,
	type PlannerPosition,
	PlannerStateMachineError,
	requestPlannerCompact,
	resumePlannerAfterRecovery,
	retryPlannerStep,
	startPlannerStep,
} from "./state-machine";

export type PlannerStateTransition =
	| { type: "start_step" }
	| { type: "finish_step"; next?: PlannerPosition }
	| { type: "finish_and_start_step"; next?: PlannerPosition }
	| { type: "advance_step" }
	| { type: "fail_step"; reason: string }
	| {
			type: "block_step";
			reason: string;
			requiresUserDecision?: boolean;
	  }
	| { type: "retry_step" }
	| { type: "request_compact"; reason?: string }
	| { type: "complete_compact" }
	| {
			type: "enter_recovery";
			reason: string;
			requiresUserDecision?: boolean;
	  }
	| { type: "resume_after_recovery"; target: PlannerPosition };

export type PlannerStateTransitionType = PlannerStateTransition["type"];

export type PlannerStateTransitionBlockCode =
	| "context_not_ready"
	| "runtime_blocked"
	| "tool_blocked"
	| "state_machine_error";

export interface ApplyPlannerStateTransitionInput {
	fs: PlannerFs;
	preflight: PlannerPreflightResult;
	transition: PlannerStateTransition;
	tool?: PlannerWrapperTool;
}

export type PlannerStateTransitionResult =
	| {
			status: "applied";
			transition: PlannerStateTransition;
			previousState: PlanStateRecord;
			state: PlanStateRecord;
	  }
	| {
			status: "blocked";
			code: PlannerStateTransitionBlockCode;
			transition: PlannerStateTransition;
			reason: string;
			state: PlanStateRecord | null;
			stateMachineErrorCode?: string;
	  };

export async function applyPlannerStateTransition(
	input: ApplyPlannerStateTransitionInput,
): Promise<PlannerStateTransitionResult> {
	if (input.preflight.context.status !== "ready") {
		return blocked({
			input,
			code: "context_not_ready",
			state: null,
			reason: input.preflight.context.reason,
		});
	}

	const previousState = input.preflight.context.state;

	if (input.tool) {
		const toolDecision = checkPlannerPreflightToolAllowed({
			preflight: input.preflight,
			tool: input.tool,
		});
		if (!toolDecision.allow) {
			return blocked({
				input,
				code: "tool_blocked",
				state: previousState,
				reason:
					toolDecision.reason ??
					`Planner wrapper ${input.tool} is not allowed now.`,
			});
		}
	}

	if (!runtimeAllowsTransition(input.preflight, input.transition)) {
		return blocked({
			input,
			code: "runtime_blocked",
			state: previousState,
			reason: `Runtime action ${input.preflight.decision.action} does not allow transition ${input.transition.type}.`,
		});
	}

	let nextState: PlanStateRecord;
	try {
		nextState = applyTransition(previousState, input.transition);
	} catch (error) {
		if (error instanceof PlannerStateMachineError) {
			return blocked({
				input,
				code: "state_machine_error",
				state: previousState,
				reason: error.message,
				stateMachineErrorCode: error.code,
			});
		}
		throw error;
	}

	await savePlanState(input.fs, input.preflight.context.planPaths, nextState);
	return {
		status: "applied",
		transition: input.transition,
		previousState,
		state: nextState,
	};
}

export function getAllowedPlannerStateTransitionTypes(
	preflight: PlannerPreflightResult,
): PlannerStateTransitionType[] {
	if (preflight.context.status !== "ready") {
		return [];
	}

	if (preflight.decision.action === "require_compact") {
		return ["request_compact", "complete_compact"];
	}

	if (
		preflight.decision.action === "require_recovery" ||
		preflight.decision.action === "require_user_decision"
	) {
		return ["resume_after_recovery"];
	}

	if (preflight.decision.action !== "allow_stage_machine") {
		return [];
	}

	const state = preflight.context.state;
	switch (state.stepStatus) {
		case "pending":
			return ["start_step", "block_step", "enter_recovery"];
		case "running":
			return state.step.startsWith("compact_") && isPlannerCompactEnabled(state)
				? ["request_compact", "fail_step", "block_step", "enter_recovery"]
				: [
						"finish_step",
						"finish_and_start_step",
						"fail_step",
						"block_step",
						"enter_recovery",
					];
		case "completed":
			return ["advance_step"];
		case "failed":
			return ["retry_step", "block_step", "enter_recovery"];
		case "blocked":
			return state.requiresUserDecision
				? ["enter_recovery"]
				: ["retry_step", "enter_recovery"];
	}
}

function applyTransition(
	state: PlanStateRecord,
	transition: PlannerStateTransition,
): PlanStateRecord {
	switch (transition.type) {
		case "start_step":
			return startPlannerStep(state);
		case "finish_step":
			return finishPlannerStep(state, { next: transition.next });
		case "finish_and_start_step":
			return finishAndStartPlannerStep(state, { next: transition.next });
		case "advance_step":
			return advancePlannerStep(state);
		case "fail_step":
			return failPlannerStep(state, transition.reason);
		case "block_step":
			return blockPlannerStep(state, transition.reason, {
				requiresUserDecision: transition.requiresUserDecision,
			});
		case "retry_step":
			return retryPlannerStep(state);
		case "request_compact":
			return requestPlannerCompact(state, transition.reason);
		case "complete_compact":
			return completePlannerCompact(state);
		case "enter_recovery":
			return enterPlannerRecovery(state, transition.reason, {
				requiresUserDecision: transition.requiresUserDecision,
			});
		case "resume_after_recovery":
			return resumePlannerAfterRecovery(state, transition.target);
	}
}

function runtimeAllowsTransition(
	preflight: PlannerPreflightResult,
	transition: PlannerStateTransition,
): boolean {
	if (transition.type === "complete_compact") {
		return preflight.decision.action === "require_compact";
	}
	if (
		transition.type === "request_compact" &&
		preflight.decision.action === "require_compact"
	) {
		return true;
	}

	if (
		transition.type === "enter_recovery" ||
		transition.type === "resume_after_recovery"
	) {
		return (
			preflight.decision.action === "allow_stage_machine" ||
			preflight.decision.action === "require_recovery" ||
			preflight.decision.action === "require_user_decision"
		);
	}

	return preflight.decision.action === "allow_stage_machine";
}

function blocked(input: {
	input: ApplyPlannerStateTransitionInput;
	code: PlannerStateTransitionBlockCode;
	state: PlanStateRecord | null;
	reason: string;
	stateMachineErrorCode?: string;
}): PlannerStateTransitionResult {
	return {
		status: "blocked",
		code: input.code,
		transition: input.input.transition,
		reason: input.reason,
		state: input.state,
		stateMachineErrorCode: input.stateMachineErrorCode,
	};
}

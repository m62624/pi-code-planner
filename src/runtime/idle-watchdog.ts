import { MS_PER_MINUTE } from "../constants";
import type { PlannerIdleSettings } from "../settings/schema";
import type { PlanStateRecord } from "../storage/schema";
import { PLANNER_SYSTEM_INSTRUCTIONS_HEADER } from "./compact";

export type PlannerIdleWakeDecision =
	| { action: "disabled"; reason: string }
	| { action: "initialize"; timestamp: number; reason: string }
	| { action: "wait"; reason: string; remainingMs: number }
	| { action: "wake"; message: string; timestamp: number };

const IDLE_EXECUTION_STEPS = new Set<PlanStateRecord["step"]>([
	"write_tdd_plan",
	"write_tests",
	"run_failing_tests",
	"implement_task",
	"contract_check",
	"refactor_task",
	"run_final_tests",
]);

const USER_WAIT_STEPS = new Set<PlanStateRecord["step"]>([
	"await_goal_approval",
	"present_result",
	"await_user_acceptance",
]);

export function evaluatePlannerIdleWake(input: {
	state: PlanStateRecord;
	settings: PlannerIdleSettings;
	now: number;
	/** True while a real compaction is running — suppresses the compact rescue. */
	compactionInFlight?: boolean;
}): PlannerIdleWakeDecision {
	if (!input.settings.enabled) {
		return {
			action: "disabled",
			reason: "Planner idle watchdog is disabled in settings.",
		};
	}

	// A compact boundary that is pending but not actively compacting is a stall:
	// the compaction neither completed (session_compact) nor errored (onError),
	// so the normal gate (which silences on stepStatus !== "running") would leave
	// the session frozen forever. Bypass the gate and rescue it instead.
	const compactStall = isStuckCompactBoundary(
		input.state,
		Boolean(input.compactionInFlight),
	);
	if (!compactStall) {
		const gate = explainPlannerIdleGate(input.state, input.settings);
		if (gate) {
			return { action: "disabled", reason: gate };
		}
	}

	const timing = resolveIdleTiming(input.state, input.settings, input.now);
	if (timing.kind !== "ready") {
		return timing.decision;
	}

	return {
		action: "wake",
		timestamp: input.now,
		message: compactStall
			? buildPlannerCompactStallWakeMessage({
					state: input.state,
					timeoutMinutes: input.settings.timeoutMinutes,
					idleMinutes: timing.idleMinutes,
				})
			: buildPlannerIdleWakeMessage({
					state: input.state,
					timeoutMinutes: input.settings.timeoutMinutes,
					idleMinutes: timing.idleMinutes,
				}),
	};
}

// A pending compact boundary with no compaction in flight, at a normal (not
// broken / user-decision) position — the exact shape a failed or hung
// compaction leaves behind.
function isStuckCompactBoundary(
	state: PlanStateRecord,
	compactionInFlight: boolean,
): boolean {
	return (
		state.requiresCompact &&
		!compactionInFlight &&
		!state.broken &&
		!state.requiresUserDecision
	);
}

type IdleTiming =
	| { kind: "ready"; idleMinutes: number }
	| { kind: "pending"; decision: PlannerIdleWakeDecision };

// Shared idle-timer logic for both the normal wake and the compact rescue:
// initialize a missing timestamp, wait inside the timeout, dedup an already
// queued wake, otherwise report ready with the elapsed idle minutes.
function resolveIdleTiming(
	state: PlanStateRecord,
	settings: PlannerIdleSettings,
	now: number,
): IdleTiming {
	const lastToolCallAt = state.lastPlannerToolCallAt;
	if (!lastToolCallAt) {
		return {
			kind: "pending",
			decision: {
				action: "initialize",
				timestamp: now,
				reason: "Planner tool activity timestamp is missing.",
			},
		};
	}

	const timeoutMs = settings.timeoutMinutes * 60 * 1000;
	const idleMs = now - lastToolCallAt;
	if (idleMs < timeoutMs) {
		return {
			kind: "pending",
			decision: {
				action: "wait",
				reason: "Planner tool activity is still inside the idle timeout.",
				remainingMs: timeoutMs - idleMs,
			},
		};
	}

	if (state.lastIdleWakeAt !== null && state.lastIdleWakeAt >= lastToolCallAt) {
		return {
			kind: "pending",
			decision: {
				action: "wait",
				reason: "Planner idle wake was already queued for this idle window.",
				remainingMs: 0,
			},
		};
	}

	return { kind: "ready", idleMinutes: Math.floor(idleMs / MS_PER_MINUTE) };
}

// Single source of truth for "is it safe to send an idle wake-up right now".
// The watchdog only fires while state.step is actively running model work;
// any blocked/compact/user-decision/done/recovery state must return a reason
// here instead of being filtered elsewhere, or a wake message could land
// while the user (not the model) is expected to act next.
export function explainPlannerIdleGate(
	state: PlanStateRecord,
	settings: PlannerIdleSettings,
): string | null {
	if (!settings.enabled)
		return "Planner idle watchdog is disabled in settings.";
	if (state.stepStatus !== "running") {
		return `Planner step is ${state.stepStatus}, not running.`;
	}
	if (state.broken) return "Planner state is broken.";
	if (state.requiresUserDecision)
		return "Planner is waiting for a user decision.";
	if (state.requiresCompact) return "Planner compact gate is pending.";
	if (state.execRunning)
		return "planner_exec is running — idle watchdog paused.";
	if (state.step.startsWith("compact_")) return "Planner is at a compact step.";
	if (state.stage === "done" || state.stage === "recovery") {
		return `Planner stage ${state.stage} is not an idle-wake stage.`;
	}
	if (USER_WAIT_STEPS.has(state.step)) {
		return `Planner step ${state.step} is waiting for the user.`;
	}
	if (
		state.stage === "discovery" &&
		state.step === "write_questions" &&
		state.questionsSubmitted &&
		!state.questionsResolved
	) {
		return "Discovery questions were submitted and need user answers.";
	}
	if (state.stage === "execution" && !IDLE_EXECUTION_STEPS.has(state.step)) {
		return `Execution step ${state.step} is not a model execution step.`;
	}
	return null;
}

export function buildPlannerIdleWakeMessage(input: {
	state: PlanStateRecord;
	timeoutMinutes: number;
	idleMinutes: number;
}): string {
	const stuckLine = input.state.lastStuckReportPath
		? `- lastStuckReport: ${input.state.lastStuckReportPath}`
		: "- lastStuckReport: (none)";
	return [
		PLANNER_SYSTEM_INSTRUCTIONS_HEADER,
		"",
		"Planner idle wake triggered.",
		`No planner/tool calls were recorded for at least ${input.timeoutMinutes} minutes while the current planner step is running.`,
		"Call planner_status first. Continue only from the exact persisted state it reports.",
		"If the task is still solvable, make the next focused tool call now.",
		"If you are stuck, do not repeat the same attempt. Fill the stuckLoad score, inspect logs, git diff/stat, and focused test/build output, then call planner_report_stuck with the evidence and next debug plan.",
		"Stuck is an instrumentation signal, not a failure identity. The next compact will preserve evidence and reset tone; continue with one falsifiable probe.",
		"",
		"## Stuck Load Scale",
		"- failedAttempts: 0 none, 1 one, 2 two, 3 three or more repeated failed attempts",
		"- evidenceQuality: 0 exact repro, 1 partial error, 2 symptom only, 3 vague failure",
		"- hypothesisChurn: 0 one clear hypothesis, 1 two, 2 many unranked, 3 repeated guesses",
		"- contextDrift: 0 artifacts reread, 1 one stale, 2 several stale, 3 relying on memory",
		"- verificationGap: 0 focused check, 1 broad check, 2 unclear check, 3 no verification path",
		"",
		"## Current Stored Position",
		`- stage: ${input.state.stage}`,
		`- step: ${input.state.step}`,
		`- stepStatus: ${input.state.stepStatus}`,
		`- activeTaskId: ${input.state.activeTaskId ?? "(none)"}`,
		`- idleMinutes: ${input.idleMinutes}`,
		stuckLine,
	].join("\n");
}

export function buildPlannerCompactStallWakeMessage(input: {
	state: PlanStateRecord;
	timeoutMinutes: number;
	idleMinutes: number;
}): string {
	return [
		PLANNER_SYSTEM_INSTRUCTIONS_HEADER,
		"",
		"Planner compact boundary is stuck.",
		`A compaction was requested but did not complete for at least ${input.timeoutMinutes} minutes (it neither finished nor reported an error).`,
		"The context is already small enough — the boundary's goal is met.",
		"Call planner_status first, then planner_complete_compact to clear the pending compact boundary and continue from the reported step.",
		"Do not call planner_request_compact again — retrying will not help.",
		"",
		"## Current Stored Position",
		`- stage: ${input.state.stage}`,
		`- step: ${input.state.step}`,
		`- stepStatus: ${input.state.stepStatus}`,
		`- requiresCompact: ${String(input.state.requiresCompact)}`,
		`- idleMinutes: ${input.idleMinutes}`,
	].join("\n");
}

export function markPlannerToolActivity(
	state: PlanStateRecord,
	now: number,
): PlanStateRecord {
	return {
		...state,
		lastPlannerToolCallAt: now,
		lastIdleWakeAt: null,
		idleWakeInFlight: false,
	};
}

export function markPlannerIdleWakeQueued(
	state: PlanStateRecord,
	now: number,
): PlanStateRecord {
	return {
		...state,
		lastIdleWakeAt: now,
		idleWakeInFlight: true,
	};
}

export function initializePlannerToolActivity(
	state: PlanStateRecord,
	now: number,
): PlanStateRecord {
	return state.lastPlannerToolCallAt
		? state
		: {
				...state,
				lastPlannerToolCallAt: now,
			};
}

import { getAllowedPlannerWrapperTools } from "../guard/tool-policy";
import {
	PLANNER_STAGE_STEPS,
	type PlannerStage,
	type PlanStateRecord,
} from "../storage/schema";
import {
	getAllowedNextPlannerPositions,
	getPlannerStepStage,
	isPlannerCompactEnabled,
	type PlannerPosition,
} from "./state-machine";
import { getPlannerStepRule, type PlannerStepRule } from "./status";

// Stage order used only to label a branch target as a backward/fix move.
const STAGE_ORDER: PlannerStage[] = [
	"init",
	"intake",
	"discovery",
	"planning",
	"execution",
	"finalize",
	"done",
	"recovery",
];

/**
 * Compact, model-facing guidance for the step the planner has just moved into.
 *
 * It answers the same questions as planner_status — where am I, what is the
 * goal, what do I do next — but is deliberately lighter: no Stage Behavior,
 * no allowed-tool dumps, no full instruction body. The full status remains the
 * heavier source of truth; this keeps the model moving without calling it after
 * every transition.
 */
export function buildNextStepHint(state: PlanStateRecord): string {
	const rule = safeRule(state);
	const lines: string[] = [
		`You are in worktree \`${state.worktreePath ?? "(none)"}\` (branch \`${state.currentBranch ?? "(unknown)"}\`) — work here.`,
		`Now: ${state.stage}/${state.step} (${state.stepStatus}).`,
	];
	if (rule) {
		lines.push(`Goal: ${rule.objective}`);
		const firstAction = rule.requiredActions[0];
		if (firstAction) {
			lines.push(`Do now: ${firstAction}`);
		}
		lines.push(`Exit when: ${rule.exitCondition}`);
	}
	lines.push(`Next: ${describeNextMove(state, rule?.nextInstruction)}`);
	const tools = getAllowedPlannerWrapperTools(state);
	if (tools.length > 0) {
		// Name the wrappers permitted at this exact step so the model reaches for
		// the right planner tool instead of a built-in write/edit.
		lines.push(`Tools allowed now: ${tools.join(", ")}.`);
		// Each planner_*_submit belongs to one step. The model often reaches for
		// the next step's submit tool early and gets blocked; spell out the order.
		lines.push(
			"Order: only the tools listed above work at this step. A planner_*_submit for a later step is blocked until you call planner_finish_step to advance there.",
		);
	}
	lines.push(
		`If unsure, re-read \`${getPlannerStepStage(state.step)}.md\` or call planner_status.`,
	);
	return lines.join("\n");
}

function describeNextMove(
	state: PlanStateRecord,
	fallback: string | undefined,
): string {
	if (state.step.startsWith("compact_") && isPlannerCompactEnabled(state)) {
		return "Prepare the compact boundary summary, then call planner_request_compact.";
	}
	const allowed = safeAllowedNext(state);
	if (allowed.length > 1) {
		const targets = allowed
			.map(
				(position) =>
					`{stage: '${position.stage}', step: '${position.step}'}${
						isBackwardMove(state, position) ? " (loops back)" : ""
					}`,
			)
			.join(" or ");
		return `When the exit condition holds, call planner_finish_step and choose ONE target: ${targets}.`;
	}
	return fallback ?? "When the exit condition holds, call planner_finish_step.";
}

function isBackwardMove(
	state: PlanStateRecord,
	target: PlannerPosition,
): boolean {
	const currentStageIndex = STAGE_ORDER.indexOf(state.stage);
	const targetStageIndex = STAGE_ORDER.indexOf(target.stage);
	if (targetStageIndex !== currentStageIndex) {
		return targetStageIndex < currentStageIndex;
	}
	const steps = PLANNER_STAGE_STEPS[state.stage] as readonly string[];
	return steps.indexOf(target.step) < steps.indexOf(state.step);
}

function safeRule(state: PlanStateRecord): PlannerStepRule | null {
	try {
		return getPlannerStepRule({ stage: state.stage, step: state.step });
	} catch {
		return null;
	}
}

function safeAllowedNext(state: PlanStateRecord): PlannerPosition[] {
	try {
		return getAllowedNextPlannerPositions({
			stage: state.stage,
			step: state.step,
			creationMethod: state.creationMethod,
		});
	} catch {
		return [];
	}
}

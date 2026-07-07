import {
	type InitStep,
	PLANNER_STAGE_STEPS,
	type PlannerStage,
	type PlannerStep,
	type PlanStateRecord,
	type StepStatus,
} from "../storage/schema";

export interface PlannerPosition {
	stage: PlannerStage;
	step: PlannerStep;
}

interface PlannerPositionContext extends PlannerPosition {
	creationMethod?: PlanStateRecord["creationMethod"];
}

export type PlannerStateMachineErrorCode =
	| "invalid_position"
	| "invalid_step_status"
	| "state_blocked"
	| "step_already_completed"
	| "not_running"
	| "not_completed"
	| "invalid_next_step"
	| "ambiguous_next_step"
	| "not_compact_step"
	| "compact_not_required"
	| "not_failed_or_blocked"
	| "invalid_recovery_target";

export class PlannerStateMachineError extends Error {
	constructor(
		public readonly code: PlannerStateMachineErrorCode,
		message: string,
	) {
		super(message);
		this.name = "PlannerStateMachineError";
	}
}

export interface CompletePlannerStepOptions {
	next?: PlannerPosition;
}

export interface BlockPlannerStepOptions {
	requiresUserDecision?: boolean;
}

export interface EnterPlannerRecoveryOptions {
	requiresUserDecision?: boolean;
}

const INIT_STEPS_BEFORE_WORKTREE = new Set<InitStep>([
	"check_project",
	"check_git",
	"prepare_storage",
	"choose_worktree_location",
	"create_plan_record",
	"create_plan_worktree",
]);

const COMPACT_STEPS = new Set<PlannerStep>([
	"compact_discovery",
	"compact_spec",
	"compact_planning",
	"compact_task",
	"compact_before_doubt",
	"compact_finalize",
]);

const STEP_TO_STAGE = buildStepToStageMap();

export function isPlannerCompactEnabled(state: PlanStateRecord): boolean {
	const boundaries = state.compactBoundaries ?? {
		stage: true,
		task: false,
	};
	switch (state.step) {
		case "compact_task":
			return boundaries.task;
		case "compact_discovery":
		case "compact_spec":
		case "compact_planning":
		case "compact_finalize":
			return boundaries.stage;
		default:
			return false;
	}
}

export function getPlannerStepStage(step: PlannerStep): PlannerStage {
	const stage = STEP_TO_STAGE.get(step);
	if (!stage) {
		throw new PlannerStateMachineError(
			"invalid_position",
			`Unknown planner step: ${step}.`,
		);
	}
	return stage;
}

export function isPlannerStepInStage(input: PlannerPosition): boolean {
	return getPlannerStepStage(input.step) === input.stage;
}

export function getAllowedNextPlannerPositions(
	input: PlannerPositionContext,
): PlannerPosition[] {
	assertValidPosition(input);

	if (input.stage === "recovery") {
		return nextWithinStage(input);
	}

	if (input.stage === "init" && input.step === "enter_intake") {
		return [{ stage: "intake", step: "draft_goal" }];
	}
	if (input.stage === "intake" && input.step === "await_goal_approval") {
		// The improve flow already ran discovery before drafting the goal, so
		// approval continues into the spec stage instead of repeating discovery —
		// every plan authors a spec; the spec is the source of truth without
		// exceptions.
		return input.creationMethod === "improve"
			? [
					{ stage: "intake", step: "draft_goal" },
					{ stage: "spec", step: "draft_requirements" },
				]
			: [
					{ stage: "intake", step: "draft_goal" },
					{ stage: "discovery", step: "scan_project_structure" },
				];
	}
	if (input.stage === "discovery" && input.step === "enter_planning") {
		// Retargeted by the SDD layer: discovery now enters the spec stage. The
		// step keeps its historical name so persisted legacy state.json stays
		// valid (REQ-11).
		return input.creationMethod === "improve"
			? [
					{ stage: "spec", step: "draft_requirements" },
					{ stage: "intake", step: "draft_goal" },
				]
			: [{ stage: "spec", step: "draft_requirements" }];
	}
	if (input.stage === "spec" && input.step === "verify_spec") {
		// Forward to the compact boundary, or loop back to elicit_gaps when the
		// gate reports gaps that need user answers before the spec can pass.
		return [
			{ stage: "spec", step: "compact_spec" },
			{ stage: "spec", step: "elicit_gaps" },
		];
	}
	if (input.stage === "spec" && input.step === "finish_spec") {
		return [{ stage: "planning", step: "read_context" }];
	}
	if (input.stage === "planning" && input.step === "enter_execution") {
		return [{ stage: "execution", step: "prepare_task" }];
	}
	if (input.stage === "execution" && input.step === "run_final_tests") {
		// Final checks may reveal a fix that needs an editing step. Allow going
		// back to implement_task to fix + re-verify, not only forward.
		return [
			{ stage: "execution", step: "capture_skill" },
			{ stage: "execution", step: "implement_task" },
		];
	}
	if (input.stage === "execution" && input.step === "select_next_task") {
		return [
			{ stage: "execution", step: "prepare_task" },
			{ stage: "finalize", step: "verify_plan_branch" },
		];
	}
	if (input.stage === "finalize" && input.step === "doubt_review") {
		return [
			{ stage: "finalize", step: "write_final_summary" },
			{ stage: "planning", step: "read_context" },
		];
	}
	if (input.stage === "finalize" && input.step === "enter_done") {
		return [{ stage: "done", step: "present_result" }];
	}
	if (input.stage === "done" && input.step === "await_user_acceptance") {
		return [
			{ stage: "done", step: "handle_change_request" },
			{ stage: "done", step: "prepare_output_branch" },
		];
	}
	if (input.stage === "done" && input.step === "handle_change_request") {
		// A change request amends the SPEC first (REQ-10): the spec is the
		// source of truth, so it is re-drafted and re-verified before replanning.
		// Legacy plans without spec.json keep the direct road to planning.
		return [
			{ stage: "spec", step: "draft_requirements" },
			{ stage: "planning", step: "read_context" },
		];
	}

	return nextWithinStage(input);
}

export function startPlannerStep(state: PlanStateRecord): PlanStateRecord {
	assertValidStatePosition(state);
	assertNormalFlowOpen(state);

	if (state.stepStatus === "completed") {
		throw new PlannerStateMachineError(
			"step_already_completed",
			"Completed planner step cannot be started again. Advance first.",
		);
	}
	if (state.stepStatus === "running") {
		return state;
	}
	if (state.stepStatus !== "pending" && state.stepStatus !== "failed") {
		throw new PlannerStateMachineError(
			"invalid_step_status",
			`Cannot start planner step from ${state.stepStatus}.`,
		);
	}

	return {
		...state,
		stepStatus: "running",
		nextStep: null,
		blockedReason: null,
	};
}

export function completePlannerStep(
	state: PlanStateRecord,
	options: CompletePlannerStepOptions = {},
): PlanStateRecord {
	assertValidStatePosition(state);
	assertNormalFlowOpen(state);
	assertRunning(state);

	const next = selectNextPosition(state, options.next);
	return {
		...state,
		stepStatus: "completed",
		nextStep: next?.step ?? null,
		blockedReason: null,
	};
}

export function advancePlannerStep(state: PlanStateRecord): PlanStateRecord {
	assertValidStatePosition(state);
	if (state.stepStatus !== "completed") {
		throw new PlannerStateMachineError(
			"not_completed",
			"Only a completed planner step can advance.",
		);
	}

	const allowed = getAllowedNextPlannerPositions(state);
	if (allowed.length === 0) {
		if (state.nextStep === null) {
			return state;
		}
		throw new PlannerStateMachineError(
			"invalid_next_step",
			`Terminal planner step ${state.stage}/${state.step} cannot advance to ${state.nextStep} — no next positions exist.`,
		);
	}

	const next = allowed.find((candidate) => candidate.step === state.nextStep);
	if (!next) {
		throw new PlannerStateMachineError(
			"invalid_next_step",
			`Planner nextStep ${state.nextStep ?? "(none)"} is not allowed from ${state.stage}/${state.step}. Allowed next: ${formatAllowedTargets(allowed)}.`,
		);
	}

	return {
		...state,
		stage: next.stage,
		step: next.step,
		stepStatus: "pending",
		nextStep: null,
		blockedReason: null,
	};
}

export function finishPlannerStep(
	state: PlanStateRecord,
	options: CompletePlannerStepOptions = {},
): PlanStateRecord {
	return startNextPlannerStep(
		advancePlannerStep(completePlannerStep(state, options)),
	);
}

export function failPlannerStep(
	state: PlanStateRecord,
	reason: string,
): PlanStateRecord {
	assertValidStatePosition(state);
	assertRunning(state);
	return markStepStopped(state, "failed", reason);
}

export function blockPlannerStep(
	state: PlanStateRecord,
	reason: string,
	options: BlockPlannerStepOptions = {},
): PlanStateRecord {
	assertValidStatePosition(state);
	if (state.stepStatus === "completed") {
		throw new PlannerStateMachineError(
			"step_already_completed",
			"Completed planner step cannot be blocked.",
		);
	}
	return {
		...markStepStopped(state, "blocked", reason),
		requiresUserDecision:
			options.requiresUserDecision ?? state.requiresUserDecision,
	};
}

export function retryPlannerStep(state: PlanStateRecord): PlanStateRecord {
	assertValidStatePosition(state);
	if (state.requiresUserDecision) {
		throw new PlannerStateMachineError(
			"state_blocked",
			"Planner step requires a user decision before retry.",
		);
	}
	if (state.stepStatus !== "failed" && state.stepStatus !== "blocked") {
		throw new PlannerStateMachineError(
			"not_failed_or_blocked",
			`Cannot retry planner step from ${state.stepStatus}.`,
		);
	}
	return {
		...state,
		stepStatus: "pending",
		nextStep: null,
		blockedReason: null,
	};
}

export function requestPlannerCompact(
	state: PlanStateRecord,
	reason = "Planner compact boundary is required.",
): PlanStateRecord {
	assertValidStatePosition(state);
	if (!COMPACT_STEPS.has(state.step)) {
		throw new PlannerStateMachineError(
			"not_compact_step",
			`Planner step ${state.step} is not a compact step.`,
		);
	}
	if (state.requiresCompact && state.stepStatus === "blocked") {
		return state;
	}
	assertRunning(state);
	return {
		...state,
		stepStatus: "blocked",
		nextStep: null,
		requiresCompact: true,
		blockedReason: reason,
	};
}

export function completePlannerCompact(
	state: PlanStateRecord,
): PlanStateRecord {
	assertValidStatePosition(state);
	if (!COMPACT_STEPS.has(state.step)) {
		throw new PlannerStateMachineError(
			"not_compact_step",
			`Planner step ${state.step} is not a compact step.`,
		);
	}
	if (!state.requiresCompact) {
		throw new PlannerStateMachineError(
			"compact_not_required",
			"Planner compact is not pending.",
		);
	}
	const next = selectNextPosition(state);
	return startNextPlannerStep(
		advancePlannerStep({
			...state,
			stepStatus: "completed",
			nextStep: next?.step ?? null,
			requiresCompact: false,
			// The compact wiped the model's working memory; re-inline the full
			// stage instruction on the very next planner_status (consumed there).
			pendingFullStatus: true,
			blockedReason: null,
		}),
	);
}

export function enterPlannerRecovery(
	state: PlanStateRecord,
	reason: string,
	options: EnterPlannerRecoveryOptions = {},
): PlanStateRecord {
	return {
		...state,
		stage: "recovery",
		step: "read_state",
		stepStatus: "blocked",
		nextStep: null,
		requiresCompact: false,
		requiresUserDecision: options.requiresUserDecision ?? true,
		broken: true,
		brokenReason: reason,
		blockedReason: reason,
	};
}

// Recovery is the one flow allowed to jump to an arbitrary non-recovery
// stage/step instead of advancing through the normal strict sequence — every
// other transition in this file only moves to the next position the state
// machine itself computes.
export function resumePlannerAfterRecovery(
	state: PlanStateRecord,
	target: PlannerPosition,
): PlanStateRecord {
	if (state.stage !== "recovery") {
		throw new PlannerStateMachineError(
			"invalid_position",
			"Planner can resume from recovery only while state.stage is recovery.",
		);
	}
	if (target.stage === "recovery" || !isPlannerStepInStage(target)) {
		throw new PlannerStateMachineError(
			"invalid_recovery_target",
			`Invalid recovery target ${target.stage}/${target.step}.`,
		);
	}
	return {
		...state,
		stage: target.stage,
		step: target.step,
		stepStatus: "pending",
		nextStep: null,
		requiresCompact: false,
		requiresUserDecision: false,
		broken: false,
		brokenReason: null,
		blockedReason: null,
	};
}

export function isBeforePlannerWorktreeStep(state: PlanStateRecord): boolean {
	return (
		state.stage === "init" &&
		INIT_STEPS_BEFORE_WORKTREE.has(state.step as InitStep)
	);
}

function nextWithinStage(input: PlannerPosition): PlannerPosition[] {
	const steps = PLANNER_STAGE_STEPS[input.stage] as readonly PlannerStep[];
	const index = steps.indexOf(input.step);
	const nextStep = steps[index + 1];
	return nextStep ? [{ stage: input.stage, step: nextStep }] : [];
}

/**
 * Render the allowed next positions as `{stage: 'x', step: 'y'} or …`, so an
 * invalid/ambiguous-transition error names the exact targets the model may pass
 * as nextStage/nextStep instead of leaving it to guess step names (which a
 * local model did four times in one run before landing a valid one).
 */
function formatAllowedTargets(allowed: readonly PlannerPosition[]): string {
	return allowed
		.map((p) => `{stage: '${p.stage}', step: '${p.step}'}`)
		.join(" or ");
}

function selectNextPosition(
	state: PlanStateRecord,
	requested?: PlannerPosition,
): PlannerPosition | null {
	const allowed = getAllowedNextPlannerPositions(state);
	if (allowed.length === 0) {
		if (requested) {
			throw new PlannerStateMachineError(
				"invalid_next_step",
				`Terminal planner step ${state.stage}/${state.step} cannot advance to ${requested.stage}/${requested.step} — no next positions exist.`,
			);
		}
		return null;
	}
	if (allowed.length === 1 && !requested) {
		return allowed[0] ?? null;
	}
	if (!requested) {
		throw new PlannerStateMachineError(
			"ambiguous_next_step",
			`Planner step ${state.stage}/${state.step} has multiple allowed next positions: ${formatAllowedTargets(allowed)}. Specify one via nextStage/nextStep.`,
		);
	}
	const next = allowed.find(
		(candidate) =>
			candidate.stage === requested.stage && candidate.step === requested.step,
	);
	if (!next) {
		throw new PlannerStateMachineError(
			"invalid_next_step",
			`Planner step ${requested.stage}/${requested.step} is not allowed after ${state.stage}/${state.step}. Allowed next: ${formatAllowedTargets(allowed)}.`,
		);
	}
	return next;
}

function markStepStopped(
	state: PlanStateRecord,
	stepStatus: Extract<StepStatus, "failed" | "blocked">,
	reason: string,
): PlanStateRecord {
	return {
		...state,
		stepStatus,
		nextStep: null,
		blockedReason: reason,
	};
}

function startNextPlannerStep(state: PlanStateRecord): PlanStateRecord {
	return state.stepStatus === "pending" ? startPlannerStep(state) : state;
}

function assertRunning(state: PlanStateRecord): void {
	if (state.stepStatus !== "running") {
		throw new PlannerStateMachineError(
			"not_running",
			`Planner step must be running, got ${state.stepStatus}.`,
		);
	}
}

function assertNormalFlowOpen(state: PlanStateRecord): void {
	if (state.broken || state.requiresUserDecision || state.requiresCompact) {
		throw new PlannerStateMachineError(
			"state_blocked",
			"Planner state is blocked by recovery, user decision, or compact.",
		);
	}
}

function assertValidStatePosition(state: PlanStateRecord): void {
	assertValidPosition({ stage: state.stage, step: state.step });
}

function assertValidPosition(input: PlannerPosition): void {
	if (!isPlannerStepInStage(input)) {
		throw new PlannerStateMachineError(
			"invalid_position",
			`Invalid planner position ${input.stage}/${input.step}.`,
		);
	}
}

function buildStepToStageMap(): Map<PlannerStep, PlannerStage> {
	const map = new Map<PlannerStep, PlannerStage>();
	for (const [stage, steps] of Object.entries(PLANNER_STAGE_STEPS) as Array<
		[PlannerStage, readonly PlannerStep[]]
	>) {
		for (const step of steps) {
			if (map.has(step)) {
				throw new PlannerStateMachineError(
					"invalid_position",
					`Planner step must be unique across stages: ${step}.`,
				);
			}
			map.set(step, stage);
		}
	}
	return map;
}

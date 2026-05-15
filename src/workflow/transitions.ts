import type {
	AttemptStage,
	PlanStage,
	WorkflowTransitionDecision,
	WorkItemStage,
} from "./schema";

const PLAN_TRANSITIONS: Record<PlanStage, readonly PlanStage[]> = {
	idle: ["plan_draft"],
	plan_draft: ["discovery_full", "plan_cancelled"],
	discovery_full: ["discovery_compact_required", "recovery_required"],
	discovery_compact_required: ["post_discovery_questions", "recovery_required"],
	post_discovery_questions: [
		"discovery_full",
		"todo_planning",
		"plan_cancelled",
		"recovery_required",
	],
	todo_planning: ["skeleton_planning", "plan_cancelled", "recovery_required"],
	skeleton_planning: ["skeleton_write", "todo_planning", "recovery_required"],
	skeleton_write: ["stub_audit", "recovery_required"],
	stub_audit: ["skeleton_planning", "plan_ready", "recovery_required"],
	plan_ready: ["plan_active", "plan_cancelled", "recovery_required"],
	plan_active: ["plan_finalize", "recovery_required"],
	plan_finalize: ["plan_completed", "plan_cancelled", "recovery_required"],
	plan_completed: [],
	plan_cancelled: [],
	recovery_required: [
		"idle",
		"plan_draft",
		"discovery_full",
		"discovery_compact_required",
		"post_discovery_questions",
		"todo_planning",
		"skeleton_planning",
		"skeleton_write",
		"stub_audit",
		"plan_ready",
		"plan_active",
		"plan_finalize",
		"plan_cancelled",
	],
};

const WORK_ITEM_TRANSITIONS: Record<WorkItemStage, readonly WorkItemStage[]> = {
	pending: ["ready", "blocked", "skipped"],
	ready: ["active", "blocked", "skipped"],
	active: ["tdd_prepare", "blocked", "failed"],
	tdd_prepare: ["tdd_write_tests", "blocked", "failed"],
	tdd_write_tests: ["tdd_tests_commit", "tdd_prepare", "blocked", "failed"],
	tdd_tests_commit: ["experiments_running", "blocked", "failed"],
	experiments_running: ["candidate_selection", "blocked", "failed"],
	candidate_selection: ["candidate_merged", "experiments_running", "blocked"],
	candidate_merged: ["refactor", "verification", "blocked"],
	refactor: ["verification", "tdd_write_tests", "blocked", "failed"],
	verification: [
		"work_item_commit",
		"refactor",
		"experiments_running",
		"blocked",
	],
	work_item_commit: ["signature_refresh", "blocked", "failed"],
	signature_refresh: ["work_item_compact_required", "blocked", "failed"],
	work_item_compact_required: ["completed", "blocked"],
	completed: [],
	blocked: [
		"ready",
		"active",
		"tdd_prepare",
		"tdd_write_tests",
		"experiments_running",
		"candidate_selection",
		"refactor",
		"verification",
		"work_item_commit",
		"signature_refresh",
		"work_item_compact_required",
		"failed",
		"skipped",
	],
	failed: ["ready", "skipped"],
	skipped: [],
};

const ATTEMPT_TRANSITIONS: Record<AttemptStage, readonly AttemptStage[]> = {
	created: ["active", "deleted"],
	active: ["implemented", "rejected", "deleted"],
	implemented: ["verified", "active", "rejected"],
	verified: ["scored", "active", "rejected"],
	scored: ["candidate", "rejected"],
	candidate: ["selected", "rejected"],
	selected: [],
	rejected: ["deleted"],
	deleted: [],
};

function decision<TStage extends string>(
	transitions: Record<TStage, readonly TStage[]>,
	from: TStage,
	to: TStage,
): WorkflowTransitionDecision<TStage> {
	if (from === to) {
		return {
			allowed: true,
			from,
			to,
			reason: "Stage is unchanged.",
		};
	}

	const allowedTargets = transitions[from];
	if (allowedTargets.includes(to)) {
		return {
			allowed: true,
			from,
			to,
			reason: "Transition is allowed.",
		};
	}

	return {
		allowed: false,
		from,
		to,
		reason: `Cannot transition from ${from} to ${to}.`,
	};
}

export function canTransitionPlan(
	from: PlanStage,
	to: PlanStage,
): WorkflowTransitionDecision<PlanStage> {
	return decision(PLAN_TRANSITIONS, from, to);
}

export function canTransitionWorkItem(
	from: WorkItemStage,
	to: WorkItemStage,
): WorkflowTransitionDecision<WorkItemStage> {
	return decision(WORK_ITEM_TRANSITIONS, from, to);
}

export function canTransitionAttempt(
	from: AttemptStage,
	to: AttemptStage,
): WorkflowTransitionDecision<AttemptStage> {
	return decision(ATTEMPT_TRANSITIONS, from, to);
}

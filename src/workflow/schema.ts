export const PLAN_STAGES = [
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
	"plan_completed",
	"plan_cancelled",
	"recovery_required",
] as const;

export type PlanStage = (typeof PLAN_STAGES)[number];

export const WORK_ITEM_STAGES = [
	"pending",
	"ready",
	"active",
	"tdd_prepare",
	"tdd_write_tests",
	"tdd_tests_commit",
	"experiments_running",
	"candidate_selection",
	"candidate_merged",
	"refactor",
	"verification",
	"work_item_commit",
	"signature_refresh",
	"work_item_compact_required",
	"completed",
	"blocked",
	"failed",
	"skipped",
] as const;

export type WorkItemStage = (typeof WORK_ITEM_STAGES)[number];

export const ATTEMPT_STAGES = [
	"created",
	"active",
	"implemented",
	"verified",
	"scored",
	"candidate",
	"selected",
	"rejected",
	"deleted",
] as const;

export type AttemptStage = (typeof ATTEMPT_STAGES)[number];

export interface WorkflowTransitionDecision<TStage extends string> {
	allowed: boolean;
	from: TStage;
	to: TStage;
	reason: string;
}

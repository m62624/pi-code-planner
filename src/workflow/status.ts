import type {
	ExperimentAttemptStatus,
	PlanStatus,
	WorkItemStatus,
} from "../storage/schema";
import type { AttemptStage, PlanStage, WorkItemStage } from "./schema";

export function derivePlanStatus(stage: PlanStage): PlanStatus {
	switch (stage) {
		case "idle":
		case "plan_draft":
		case "discovery_full":
		case "discovery_compact_required":
		case "post_discovery_questions":
		case "todo_planning":
		case "skeleton_planning":
		case "skeleton_write":
		case "stub_audit":
		case "plan_ready":
			return "draft";
		case "plan_active":
		case "plan_finalize":
			return "active";
		case "plan_completed":
			return "completed";
		case "plan_cancelled":
			return "cancelled";
		case "recovery_required":
			return "blocked";
	}
}

export function deriveWorkItemStatus(stage: WorkItemStage): WorkItemStatus {
	switch (stage) {
		case "pending":
			return "pending";
		case "ready":
			return "ready";
		case "active":
		case "tdd_prepare":
		case "tdd_write_tests":
		case "tdd_tests_commit":
		case "experiments_running":
		case "candidate_selection":
		case "candidate_merged":
		case "refactor":
		case "verification":
		case "work_item_commit":
		case "signature_refresh":
		case "work_item_compact_required":
			return "active";
		case "completed":
			return "completed";
		case "blocked":
			return "blocked";
		case "failed":
			return "failed";
		case "skipped":
			return "skipped";
	}
}

export function deriveAttemptStatus(
	stage: AttemptStage,
): ExperimentAttemptStatus {
	switch (stage) {
		case "created":
			return "created";
		case "active":
		case "implemented":
		case "verified":
		case "scored":
			return "active";
		case "candidate":
			return "candidate";
		case "selected":
			return "selected";
		case "rejected":
			return "rejected";
		case "deleted":
			return "deleted";
	}
}

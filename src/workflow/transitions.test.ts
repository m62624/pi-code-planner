import { describe, expect, it } from "vitest";
import {
	ATTEMPT_STAGES,
	PLAN_STAGES,
	type PlanStage,
	WORK_ITEM_STAGES,
} from "./schema";
import {
	canTransitionAttempt,
	canTransitionPlan,
	canTransitionWorkItem,
} from "./transitions";

describe("plan workflow transitions", () => {
	it.each([
		["idle", "plan_draft"],
		["plan_draft", "discovery_full"],
		["discovery_full", "discovery_compact_required"],
		["discovery_compact_required", "post_discovery_questions"],
		["post_discovery_questions", "todo_planning"],
		["todo_planning", "skeleton_planning"],
		["skeleton_planning", "skeleton_write"],
		["skeleton_write", "stub_audit"],
		["stub_audit", "plan_ready"],
		["plan_ready", "plan_active"],
		["plan_active", "plan_finalize"],
		["plan_finalize", "plan_completed"],
	] as const)("allows happy path %s -> %s", (from, to) => {
		expect(canTransitionPlan(from, to)).toMatchObject({
			allowed: true,
			reason: "Transition is allowed.",
		});
	});

	it("allows returning from post-discovery questions to full discovery", () => {
		expect(
			canTransitionPlan("post_discovery_questions", "discovery_full").allowed,
		).toBe(true);
	});

	it("allows skeleton audit to return to skeleton planning", () => {
		expect(canTransitionPlan("stub_audit", "skeleton_planning").allowed).toBe(
			true,
		);
	});

	it("allows cancellation from user decision stages", () => {
		expect(canTransitionPlan("plan_draft", "plan_cancelled").allowed).toBe(
			true,
		);
		expect(canTransitionPlan("plan_ready", "plan_cancelled").allowed).toBe(
			true,
		);
		expect(canTransitionPlan("plan_finalize", "plan_cancelled").allowed).toBe(
			true,
		);
	});

	it("blocks skipping discovery compaction", () => {
		expect(canTransitionPlan("discovery_full", "todo_planning")).toMatchObject({
			allowed: false,
			reason: "Cannot transition from discovery_full to todo_planning.",
		});
	});

	it("blocks coding lifecycle before skeleton audit passes", () => {
		expect(canTransitionPlan("skeleton_write", "plan_active").allowed).toBe(
			false,
		);
	});

	it("treats terminal plan stages as terminal", () => {
		for (const terminal of ["plan_completed", "plan_cancelled"] as const) {
			for (const target of PLAN_STAGES) {
				if (target === terminal) {
					expect(canTransitionPlan(terminal, target).allowed).toBe(true);
				} else {
					expect(canTransitionPlan(terminal, target).allowed).toBe(false);
				}
			}
		}
	});

	it("allows recovery from active non-terminal stages", () => {
		for (const stage of PLAN_STAGES) {
			if (
				stage === "idle" ||
				stage === "plan_draft" ||
				stage === "plan_completed" ||
				stage === "plan_cancelled" ||
				stage === "recovery_required"
			) {
				continue;
			}
			expect(canTransitionPlan(stage, "recovery_required").allowed).toBe(true);
		}
	});

	it("allows recovery to resume to known workflow stages", () => {
		for (const target of PLAN_STAGES) {
			if (target === "plan_completed" || target === "recovery_required") {
				continue;
			}
			expect(canTransitionPlan("recovery_required", target).allowed).toBe(true);
		}
	});

	it("blocks recovery from resuming directly to completed", () => {
		expect(
			canTransitionPlan("recovery_required", "plan_completed").allowed,
		).toBe(false);
	});
});

describe("work item workflow transitions", () => {
	it.each([
		["pending", "ready"],
		["ready", "active"],
		["active", "tdd_prepare"],
		["tdd_prepare", "tdd_write_tests"],
		["tdd_write_tests", "tdd_tests_commit"],
		["tdd_tests_commit", "experiments_running"],
		["experiments_running", "candidate_selection"],
		["candidate_selection", "candidate_merged"],
		["candidate_merged", "refactor"],
		["refactor", "verification"],
		["verification", "completed"],
	] as const)("allows happy path %s -> %s", (from, to) => {
		expect(canTransitionWorkItem(from, to).allowed).toBe(true);
	});

	it("allows test stage to return to TDD preparation", () => {
		expect(
			canTransitionWorkItem("tdd_write_tests", "tdd_prepare").allowed,
		).toBe(true);
	});

	it("allows candidate selection to request more experiments", () => {
		expect(
			canTransitionWorkItem("candidate_selection", "experiments_running")
				.allowed,
		).toBe(true);
	});

	it("allows refactor to return to tests when contract changes", () => {
		expect(canTransitionWorkItem("refactor", "tdd_write_tests").allowed).toBe(
			true,
		);
	});

	it("allows verification to return to refactor or experiments", () => {
		expect(canTransitionWorkItem("verification", "refactor").allowed).toBe(
			true,
		);
		expect(
			canTransitionWorkItem("verification", "experiments_running").allowed,
		).toBe(true);
	});

	it("blocks implementation experiments before test commit", () => {
		expect(
			canTransitionWorkItem("tdd_write_tests", "experiments_running").allowed,
		).toBe(false);
	});

	it("blocks direct completion before verification", () => {
		expect(canTransitionWorkItem("candidate_merged", "completed").allowed).toBe(
			false,
		);
	});

	it("allows blocking from every active non-terminal work item stage", () => {
		for (const stage of WORK_ITEM_STAGES) {
			if (
				stage === "completed" ||
				stage === "blocked" ||
				stage === "failed" ||
				stage === "skipped"
			) {
				continue;
			}
			expect(canTransitionWorkItem(stage, "blocked").allowed).toBe(true);
		}
	});

	it("allows blocked work items to resume into controlled stages", () => {
		for (const target of [
			"ready",
			"active",
			"tdd_prepare",
			"tdd_write_tests",
			"experiments_running",
			"candidate_selection",
			"refactor",
			"verification",
		] as const) {
			expect(canTransitionWorkItem("blocked", target).allowed).toBe(true);
		}
	});

	it("treats completed and skipped as terminal", () => {
		for (const terminal of ["completed", "skipped"] as const) {
			for (const target of WORK_ITEM_STAGES) {
				if (target === terminal) {
					expect(canTransitionWorkItem(terminal, target).allowed).toBe(true);
				} else {
					expect(canTransitionWorkItem(terminal, target).allowed).toBe(false);
				}
			}
		}
	});

	it("allows failed work items to be retried or skipped only", () => {
		expect(canTransitionWorkItem("failed", "ready").allowed).toBe(true);
		expect(canTransitionWorkItem("failed", "skipped").allowed).toBe(true);
		expect(canTransitionWorkItem("failed", "active").allowed).toBe(false);
	});
});

describe("attempt workflow transitions", () => {
	it.each([
		["created", "active"],
		["active", "implemented"],
		["implemented", "verified"],
		["verified", "scored"],
		["scored", "candidate"],
		["candidate", "selected"],
	] as const)("allows happy path %s -> %s", (from, to) => {
		expect(canTransitionAttempt(from, to).allowed).toBe(true);
	});

	it("allows rework before scoring", () => {
		expect(canTransitionAttempt("implemented", "active").allowed).toBe(true);
		expect(canTransitionAttempt("verified", "active").allowed).toBe(true);
	});

	it("allows attempts to be rejected from active attempt stages", () => {
		for (const stage of [
			"active",
			"implemented",
			"verified",
			"scored",
			"candidate",
		] as const) {
			expect(canTransitionAttempt(stage, "rejected").allowed).toBe(true);
		}
	});

	it("allows rejected attempts to be deleted", () => {
		expect(canTransitionAttempt("rejected", "deleted").allowed).toBe(true);
	});

	it("blocks refactoring or reworking selected attempts", () => {
		for (const target of ATTEMPT_STAGES) {
			if (target === "selected") {
				expect(canTransitionAttempt("selected", target).allowed).toBe(true);
			} else {
				expect(canTransitionAttempt("selected", target).allowed).toBe(false);
			}
		}
	});

	it("treats deleted attempts as terminal", () => {
		for (const target of ATTEMPT_STAGES) {
			if (target === "deleted") {
				expect(canTransitionAttempt("deleted", target).allowed).toBe(true);
			} else {
				expect(canTransitionAttempt("deleted", target).allowed).toBe(false);
			}
		}
	});

	it("blocks selecting attempts before scoring", () => {
		expect(canTransitionAttempt("verified", "selected").allowed).toBe(false);
		expect(canTransitionAttempt("scored", "selected").allowed).toBe(false);
	});
});

describe("workflow transition invariants", () => {
	it("allows unchanged stage transitions for idempotent saves", () => {
		const planStage: PlanStage = "todo_planning";

		expect(canTransitionPlan(planStage, planStage)).toMatchObject({
			allowed: true,
			reason: "Stage is unchanged.",
		});
		expect(canTransitionWorkItem("refactor", "refactor").allowed).toBe(true);
		expect(canTransitionAttempt("active", "active").allowed).toBe(true);
	});
});

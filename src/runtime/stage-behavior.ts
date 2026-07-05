import type { PlannerWrapperTool } from "../guard/tool-policy";
import type { PlannerStage, PlannerStep } from "../storage/schema";

export type PlannerProjectAccess =
	| "none"
	| "read_only"
	| "planner_artifacts"
	| "test_edits"
	| "production_edits"
	| "checks_only"
	| "user_communication";

export type PlannerBehaviorAction =
	| "inspect_project"
	| "write_artifacts"
	| "state_transition"
	| "planner_git"
	| "write_tests"
	| "run_checks"
	| "write_production"
	| "refactor"
	| "compact"
	| "ask_user"
	| "cleanup";

export type PlannerBehaviorArtifact =
	| "project.json"
	| "plan.json"
	| "state.json"
	| "request.md"
	| "goal.md"
	| "spec.md"
	| "spec.json"
	| "coverage.md"
	| "plan.md"
	| "discovery.md"
	| "questions.md"
	| "decisions.md"
	| "task.json"
	| "task.md"
	| "tdd.md"
	| "refactor.md"
	| "verify.md"
	| "final_summary.md"
	| "contracts/manifest.json";

export type PlannerBehaviorGate =
	| "project_resolved"
	| "git_available"
	| "storage_ready"
	| "worktree_location_selected"
	| "plan_record_exists"
	| "plan_worktree_exists"
	| "goal_approved"
	| "spec_verified"
	| "plan_verified"
	| "active_task_selected"
	| "task_branch_ready"
	| "tdd_plan_written"
	| "tests_written_first"
	| "failing_signal_recorded"
	| "task_implemented"
	| "contract_check_completed"
	| "refactor_checked"
	| "final_tests_passed"
	| "task_merged_to_plan"
	| "next_task_decided"
	| "plan_branch_verified"
	| "final_summary_written"
	| "user_acceptance_required"
	| "output_branch_ready"
	| "worktree_cleanup_done"
	| "plan_marked_done"
	| "recovery_inspected"
	| "user_repair_decision";

export interface PlannerStageStepBehavior {
	stage: PlannerStage;
	step: PlannerStep;
	projectAccess: PlannerProjectAccess;
	actions: readonly PlannerBehaviorAction[];
	requiredArtifacts: readonly PlannerBehaviorArtifact[];
	updatedArtifacts: readonly PlannerBehaviorArtifact[];
	requiredGates: readonly PlannerBehaviorGate[];
	// Dual-gate invariant: a tool is only usable at this step if it is BOTH
	// listed here AND in guard/tool-policy.ts STEP_ALLOWED_TOOLS for the same
	// step. If the guard allows a tool this list omits, the model gets stuck
	// with no usable tool at runtime (orchestrator-gate.ts blocks it and there
	// is no fallback). Enforced across the full flag matrix by
	// tool-gating-invariant.test.ts.
	expectedTools: readonly string[];
	commitPolicy: "forbidden" | "allowed_if_dirty" | "required_if_dirty";
	compactPolicy: "not_allowed" | "request_required" | "complete_required";
}

export interface PlannerStageBehaviorToolDecision {
	allow: boolean;
	tool: PlannerWrapperTool;
	reason: string | null;
}

export const PLANNER_STAGE_BEHAVIOR = {
	check_project: behavior("init", "check_project", {
		projectAccess: "none",
		actions: ["inspect_project"],
		requiredArtifacts: [],
		updatedArtifacts: [],
		requiredGates: [],
		// planner_report_stuck is execution-only (see stuck-tools.ts); the guard
		// does not allow it during init, so it must not be advertised here.
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	check_git: behavior("init", "check_git", {
		projectAccess: "none",
		actions: ["planner_git"],
		requiredArtifacts: [],
		updatedArtifacts: [],
		requiredGates: ["project_resolved"],
		expectedTools: ["planner_git_inspect", "planner_git_init"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	prepare_storage: behavior("init", "prepare_storage", {
		projectAccess: "none",
		actions: ["write_artifacts"],
		requiredArtifacts: [],
		updatedArtifacts: ["project.json"],
		requiredGates: ["git_available"],
		// Storage setup is runtime-driven (guard allows no wrappers here). The
		// model does contract scanning/upsert later, at discovery; listing those
		// wrappers here only mis-advertised tools the guard blocks.
		expectedTools: ["planner_status"],
		commitPolicy: "required_if_dirty",
		compactPolicy: "not_allowed",
	}),
	choose_worktree_location: behavior("init", "choose_worktree_location", {
		projectAccess: "none",
		actions: ["state_transition"],
		requiredArtifacts: ["project.json"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["storage_ready"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	create_plan_record: behavior("init", "create_plan_record", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts: ["project.json"],
		updatedArtifacts: [
			"plan.json",
			"state.json",
			"plan.md",
			"discovery.md",
			"questions.md",
			"decisions.md",
		],
		requiredGates: ["worktree_location_selected"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	create_plan_worktree: behavior("init", "create_plan_worktree", {
		projectAccess: "none",
		actions: ["planner_git"],
		requiredArtifacts: ["plan.json", "state.json"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["plan_record_exists"],
		// Worktree creation is runtime-driven; guard allows only git_inspect here.
		expectedTools: ["planner_git_inspect"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	enter_intake: behavior("init", "enter_intake", {
		projectAccess: "none",
		actions: ["state_transition"],
		requiredArtifacts: ["state.json"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["plan_worktree_exists"],
		expectedTools: ["planner_finish_step"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	draft_goal: behavior("intake", "draft_goal", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts", "ask_user"],
		requiredArtifacts: ["request.md"],
		updatedArtifacts: ["goal.md"],
		requiredGates: ["plan_worktree_exists"],
		expectedTools: ["planner_goal_submit"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	await_goal_approval: behavior("intake", "await_goal_approval", {
		projectAccess: "user_communication",
		actions: ["ask_user", "state_transition"],
		requiredArtifacts: ["request.md", "goal.md"],
		updatedArtifacts: ["decisions.md", "state.json"],
		requiredGates: ["plan_worktree_exists"],
		expectedTools: ["planner_goal_decide"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),

	scan_project_structure: behavior("discovery", "scan_project_structure", {
		projectAccess: "read_only",
		actions: ["inspect_project", "write_artifacts", "planner_git"],
		requiredArtifacts: ["goal.md"],
		updatedArtifacts: ["discovery.md"],
		requiredGates: ["plan_worktree_exists"],
		expectedTools: [
			"planner_status",
			"planner_discovery_submit",
			"planner_contract_scan",
			"planner_contract_route",
			"planner_contract_read",
			"planner_contract_upsert",
			"planner_elenchus_check",
			"planner_git_commit",
			"planner_exec",
		],
		commitPolicy: "required_if_dirty",
		compactPolicy: "not_allowed",
	}),
	write_questions: behavior("discovery", "write_questions", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts: ["discovery.md"],
		updatedArtifacts: ["questions.md"],
		requiredGates: [],
		expectedTools: [
			"planner_questions_submit",
			"planner_questions_resolve",
			"planner_contract_scan",
			"planner_contract_route",
			"planner_contract_read",
			"planner_exec",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	compact_discovery: compactBehavior("discovery", "compact_discovery", [
		"discovery.md",
	]),
	enter_planning: enterBehavior("discovery", "enter_planning", []),

	draft_requirements: behavior("spec", "draft_requirements", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts: ["goal.md", "discovery.md"],
		updatedArtifacts: ["spec.md", "spec.json"],
		requiredGates: ["goal_approved"],
		expectedTools: [
			"planner_spec_submit",
			"planner_contract_route",
			"planner_contract_read",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	elicit_gaps: behavior("spec", "elicit_gaps", {
		projectAccess: "user_communication",
		actions: ["ask_user", "write_artifacts"],
		requiredArtifacts: ["spec.md", "spec.json"],
		updatedArtifacts: ["questions.md", "decisions.md", "spec.md", "spec.json"],
		requiredGates: [],
		expectedTools: [
			"planner_questions_submit",
			"planner_questions_resolve",
			"planner_spec_submit",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	verify_spec: behavior("spec", "verify_spec", {
		projectAccess: "planner_artifacts",
		actions: ["run_checks", "write_artifacts"],
		requiredArtifacts: ["spec.json"],
		updatedArtifacts: ["coverage.md", "decisions.md"],
		requiredGates: [],
		expectedTools: [
			"planner_status",
			"planner_gate_check",
			"planner_spec_submit",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	compact_spec: compactBehavior("spec", "compact_spec", [
		"spec.md",
		"spec.json",
		"coverage.md",
	]),
	finish_spec: enterBehavior("spec", "finish_spec", ["spec_verified"]),

	read_context: behavior("planning", "read_context", {
		projectAccess: "planner_artifacts",
		actions: ["inspect_project"],
		requiredArtifacts: ["discovery.md"],
		updatedArtifacts: [],
		requiredGates: [],
		expectedTools: [
			"planner_status",
			"planner_contract_route",
			"planner_contract_read",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	draft_plan: artifactBehavior(
		"planning",
		"draft_plan",
		["plan.md"],
		["discovery.md"],
		["planner_plan_submit", "planner_contract_route", "planner_contract_read"],
	),
	split_tasks: artifactBehavior(
		"planning",
		"split_tasks",
		["plan.md"],
		["plan.md"],
		["planner_contract_route", "planner_contract_read"],
	),
	write_task_files: behavior("planning", "write_task_files", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts: ["plan.md"],
		updatedArtifacts: ["task.json", "task.md"],
		requiredGates: [],
		expectedTools: [
			"planner_task_upsert",
			"planner_contract_route",
			"planner_contract_read",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	verify_plan: behavior("planning", "verify_plan", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts: ["plan.md", "task.json", "task.md"],
		updatedArtifacts: ["decisions.md"],
		requiredGates: [],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	consistency_check: behavior("planning", "consistency_check", {
		projectAccess: "planner_artifacts",
		actions: ["run_checks", "write_artifacts"],
		requiredArtifacts: ["plan.md", "task.json", "task.md"],
		updatedArtifacts: ["decisions.md"],
		requiredGates: [],
		expectedTools: [
			"planner_status",
			"planner_elenchus_check",
			"planner_contract_route",
			"planner_contract_read",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	compact_planning: compactBehavior("planning", "compact_planning", [
		"plan.md",
		"task.json",
		"task.md",
	]),
	enter_execution: enterBehavior("planning", "enter_execution", [
		"plan_verified",
	]),

	prepare_task: behavior("execution", "prepare_task", {
		projectAccess: "planner_artifacts",
		actions: ["planner_git", "write_artifacts"],
		requiredArtifacts: ["task.json", "task.md"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["plan_verified"],
		expectedTools: ["planner_git_create_task_branch"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	write_tdd_plan: behavior("execution", "write_tdd_plan", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts: ["task.md"],
		updatedArtifacts: ["tdd.md"],
		requiredGates: ["active_task_selected", "task_branch_ready"],
		expectedTools: [
			"planner_status",
			"planner_tdd_submit",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_elenchus_check",
			"planner_debug_strategy",
			"planner_debug_probe",
			"planner_debug_result",
			"planner_debug_cleanup",
			"planner_exec",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	write_tests: behavior("execution", "write_tests", {
		projectAccess: "test_edits",
		actions: ["write_tests"],
		requiredArtifacts: ["tdd.md"],
		updatedArtifacts: ["tdd.md"],
		requiredGates: ["tdd_plan_written"],
		expectedTools: [
			"planner_tdd_submit",
			"planner_git_inspect",
			"planner_git_commit",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_debug_strategy",
			"planner_debug_probe",
			"planner_debug_result",
			"planner_debug_cleanup",
			"planner_exec",
		],
		commitPolicy: "allowed_if_dirty",
		compactPolicy: "not_allowed",
	}),
	run_failing_tests: behavior("execution", "run_failing_tests", {
		projectAccess: "checks_only",
		actions: ["run_checks", "write_artifacts"],
		requiredArtifacts: ["tdd.md"],
		updatedArtifacts: ["tdd.md"],
		requiredGates: ["tests_written_first"],
		expectedTools: [
			"planner_status",
			"planner_tdd_submit",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_debug_strategy",
			"planner_debug_probe",
			"planner_debug_result",
			"planner_debug_cleanup",
			"planner_exec",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	implement_task: behavior("execution", "implement_task", {
		projectAccess: "production_edits",
		actions: ["write_production", "run_checks", "planner_git"],
		requiredArtifacts: ["tdd.md"],
		updatedArtifacts: ["tdd.md"],
		requiredGates: ["failing_signal_recorded"],
		expectedTools: [
			"planner_tdd_submit",
			"planner_git_commit",
			"planner_contract_route",
			"planner_contract_read",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_debug_strategy",
			"planner_debug_probe",
			"planner_debug_result",
			"planner_debug_cleanup",
			"planner_exec",
		],
		commitPolicy: "required_if_dirty",
		compactPolicy: "not_allowed",
	}),
	contract_check: behavior("execution", "contract_check", {
		projectAccess: "planner_artifacts",
		actions: ["inspect_project", "write_artifacts", "planner_git"],
		requiredArtifacts: ["tdd.md"],
		updatedArtifacts: ["tdd.md", "contracts/manifest.json"],
		requiredGates: ["task_implemented"],
		expectedTools: [
			"planner_tdd_submit",
			"planner_contract_check",
			"planner_contract_upsert",
			"planner_contract_route",
			"planner_contract_read",
			"planner_elenchus_check",
			"planner_git_commit",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_exec",
		],
		commitPolicy: "allowed_if_dirty",
		compactPolicy: "not_allowed",
	}),
	refactor_task: behavior("execution", "refactor_task", {
		projectAccess: "production_edits",
		actions: ["refactor", "run_checks", "planner_git"],
		requiredArtifacts: ["tdd.md"],
		updatedArtifacts: ["refactor.md"],
		requiredGates: ["task_implemented", "contract_check_completed"],
		expectedTools: [
			"planner_tdd_submit",
			"planner_refactor_review",
			"planner_git_commit",
			"planner_contract_check",
			"planner_contract_upsert",
			"planner_contract_route",
			"planner_contract_read",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_debug_strategy",
			"planner_debug_probe",
			"planner_debug_result",
			"planner_debug_cleanup",
			"planner_exec",
		],
		commitPolicy: "allowed_if_dirty",
		compactPolicy: "not_allowed",
	}),
	run_final_tests: behavior("execution", "run_final_tests", {
		projectAccess: "checks_only",
		actions: ["run_checks", "write_artifacts", "planner_git"],
		requiredArtifacts: ["tdd.md", "refactor.md"],
		updatedArtifacts: ["refactor.md"],
		requiredGates: ["refactor_checked"],
		expectedTools: [
			"planner_tdd_submit",
			"planner_git_commit",
			"planner_report_stuck",
			"planner_skill_create",
			"planner_skill_update",
			"planner_debug_strategy",
			"planner_debug_probe",
			"planner_debug_result",
			"planner_debug_cleanup",
			"planner_exec",
		],
		commitPolicy: "allowed_if_dirty",
		compactPolicy: "not_allowed",
	}),
	capture_skill: behavior("execution", "capture_skill", {
		projectAccess: "checks_only",
		actions: ["run_checks", "write_artifacts"],
		requiredArtifacts: ["tdd.md", "refactor.md"],
		updatedArtifacts: ["decisions.md"],
		requiredGates: ["final_tests_passed"],
		expectedTools: [
			"planner_git_inspect",
			"planner_skill_create",
			"planner_skill_update",
			"planner_git_discard_changes",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	merge_task_to_plan: behavior("execution", "merge_task_to_plan", {
		projectAccess: "none",
		actions: ["planner_git"],
		requiredArtifacts: ["refactor.md"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["final_tests_passed"],
		expectedTools: ["planner_tdd_submit", "planner_git_merge_task_to_plan"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	compact_task: compactBehavior("execution", "compact_task", [
		"task.md",
		"tdd.md",
		"refactor.md",
	]),
	select_next_task: behavior("execution", "select_next_task", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts", "state_transition"],
		requiredArtifacts: ["plan.md", "task.json", "refactor.md"],
		updatedArtifacts: ["state.json", "decisions.md"],
		requiredGates: ["task_merged_to_plan"],
		expectedTools: ["planner_finish_step"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),

	verify_plan_branch: behavior("finalize", "verify_plan_branch", {
		projectAccess: "checks_only",
		actions: ["run_checks", "planner_git"],
		requiredArtifacts: ["plan.md"],
		updatedArtifacts: ["verify.md"],
		requiredGates: ["next_task_decided"],
		expectedTools: [
			"planner_git_inspect",
			"planner_contract_route",
			"planner_contract_read",
			"planner_git_discard_changes",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	compact_before_doubt: compactBehavior("finalize", "compact_before_doubt", [
		"goal.md",
		"plan.md",
		"discovery.md",
		"verify.md",
		"decisions.md",
	]),
	doubt_review: behavior("finalize", "doubt_review", {
		projectAccess: "checks_only",
		actions: ["run_checks", "planner_git", "write_artifacts"],
		requiredArtifacts: ["goal.md", "plan.md", "verify.md"],
		updatedArtifacts: ["verify.md", "decisions.md"],
		requiredGates: ["plan_branch_verified"],
		expectedTools: [
			"planner_git_inspect",
			"planner_doubt_review",
			"planner_elenchus_check",
			"planner_skill_create",
			"planner_skill_update",
			"planner_contract_check",
			"planner_contract_upsert",
			"planner_contract_route",
			"planner_contract_read",
			"planner_git_discard_changes",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	write_final_summary: behavior("finalize", "write_final_summary", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts: ["plan.md", "verify.md"],
		updatedArtifacts: ["final_summary.md"],
		requiredGates: ["plan_branch_verified"],
		expectedTools: [
			"planner_status",
			"planner_summary_submit",
			"planner_skill_create",
			"planner_skill_update",
			"planner_contract_check",
			"planner_contract_upsert",
			"planner_contract_route",
			"planner_contract_read",
			"planner_git_discard_changes",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	compact_finalize: compactBehavior("finalize", "compact_finalize", [
		"final_summary.md",
		"verify.md",
	]),
	enter_done: enterBehavior("finalize", "enter_done", [
		"final_summary_written",
	]),

	present_result: behavior("done", "present_result", {
		projectAccess: "user_communication",
		actions: ["ask_user"],
		requiredArtifacts: ["final_summary.md"],
		updatedArtifacts: [],
		requiredGates: [],
		expectedTools: [
			"planner_status",
			"planner_skill_create",
			"planner_skill_update",
			"planner_contract_decide",
			"planner_git_discard_changes",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	await_user_acceptance: behavior("done", "await_user_acceptance", {
		projectAccess: "user_communication",
		actions: ["ask_user"],
		requiredArtifacts: ["final_summary.md"],
		updatedArtifacts: ["decisions.md"],
		requiredGates: ["user_acceptance_required"],
		expectedTools: [
			"planner_status",
			"planner_contract_decide",
			"planner_git_discard_changes",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	handle_change_request: behavior("done", "handle_change_request", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts", "state_transition"],
		requiredArtifacts: ["decisions.md"],
		updatedArtifacts: ["plan.md", "decisions.md", "discovery.md", "state.json"],
		requiredGates: ["user_acceptance_required"],
		expectedTools: [
			"planner_finish_step",
			"planner_plan_submit",
			"planner_discovery_submit",
		],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	prepare_output_branch: behavior("done", "prepare_output_branch", {
		projectAccess: "none",
		actions: ["cleanup"],
		requiredArtifacts: ["final_summary.md"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["user_acceptance_required"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	merge_or_export_result: behavior("done", "merge_or_export_result", {
		projectAccess: "none",
		actions: ["cleanup"],
		requiredArtifacts: ["state.json"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["output_branch_ready"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	cleanup_worktree: behavior("done", "cleanup_worktree", {
		projectAccess: "none",
		actions: ["cleanup"],
		requiredArtifacts: ["state.json"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["output_branch_ready"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	mark_done: behavior("done", "mark_done", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts: ["state.json"],
		updatedArtifacts: ["plan.json", "project.json", "state.json"],
		requiredGates: ["worktree_cleanup_done"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	cleanup_plan_files: behavior("done", "cleanup_plan_files", {
		projectAccess: "planner_artifacts",
		actions: ["cleanup"],
		requiredArtifacts: ["project.json", "plan.json"],
		updatedArtifacts: ["project.json"],
		requiredGates: ["plan_marked_done"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),

	read_state: recoveryBehavior("read_state", ["state.json"]),
	inspect_git: recoveryBehavior("inspect_git", ["state.json"]),
	compare_expected_actual: recoveryBehavior("compare_expected_actual", [
		"state.json",
	]),
	classify_recovery: recoveryBehavior("classify_recovery", ["decisions.md"]),
	ask_user_if_destructive: behavior("recovery", "ask_user_if_destructive", {
		projectAccess: "user_communication",
		actions: ["ask_user"],
		requiredArtifacts: ["decisions.md"],
		updatedArtifacts: ["decisions.md"],
		requiredGates: ["recovery_inspected"],
		expectedTools: ["planner_recovery_inspect"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
	repair_or_resume: behavior("recovery", "repair_or_resume", {
		projectAccess: "none",
		actions: ["state_transition", "run_checks"],
		requiredArtifacts: ["state.json", "decisions.md"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["user_repair_decision"],
		expectedTools: ["planner_recovery_resume", "planner_elenchus_check"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	}),
} as const satisfies Record<PlannerStep, PlannerStageStepBehavior>;

export function getPlannerStageStepBehavior(input: {
	stage: PlannerStage;
	step: PlannerStep;
}): PlannerStageStepBehavior {
	const behavior = PLANNER_STAGE_BEHAVIOR[input.step];
	if (!behavior) {
		throw new Error(`Unknown planner behavior step: ${input.step}.`);
	}
	if (behavior.stage !== input.stage) {
		throw new Error(
			`Planner behavior mismatch: ${input.stage}/${input.step} belongs to ${behavior.stage}.`,
		);
	}
	return behavior;
}

export function checkPlannerStageBehaviorWrapperTool(input: {
	behavior: PlannerStageStepBehavior;
	tool: PlannerWrapperTool;
}): PlannerStageBehaviorToolDecision {
	if (input.tool === "planner_status") {
		return allowBehaviorTool(input.tool);
	}

	// Read-only re-read of a planner artifact; safe in every stage/step.
	if (input.tool === "planner_artifact_read") {
		return allowBehaviorTool(input.tool);
	}

	if (input.tool === "planner_git_inspect") {
		return allowBehaviorTool(input.tool);
	}

	if (input.tool === "planner_git_commit") {
		return input.behavior.commitPolicy === "forbidden"
			? blockBehaviorTool(
					input.tool,
					`Stage behavior forbids planner commits at ${input.behavior.stage}/${input.behavior.step}.`,
				)
			: allowBehaviorTool(input.tool);
	}

	if (isRecoveryTool(input.tool)) {
		return input.behavior.stage === "recovery" ||
			input.behavior.expectedTools.includes(input.tool)
			? allowBehaviorTool(input.tool)
			: blockBehaviorTool(
					input.tool,
					`Stage behavior does not allow recovery wrappers at ${input.behavior.stage}/${input.behavior.step}.`,
				);
	}

	if (isStateChangingGitTool(input.tool)) {
		return input.behavior.actions.includes("planner_git")
			? allowBehaviorTool(input.tool)
			: blockBehaviorTool(
					input.tool,
					`Stage behavior does not allow git mutations at ${input.behavior.stage}/${input.behavior.step}.`,
				);
	}

	return input.behavior.expectedTools.includes(input.tool)
		? allowBehaviorTool(input.tool)
		: blockBehaviorTool(
				input.tool,
				`Stage behavior does not list ${input.tool} as expected at ${input.behavior.stage}/${input.behavior.step}.`,
			);
}

function behavior(
	stage: PlannerStage,
	step: PlannerStep,
	spec: Omit<PlannerStageStepBehavior, "stage" | "step">,
): PlannerStageStepBehavior {
	return { stage, step, ...spec };
}

function artifactBehavior(
	stage: PlannerStage,
	step: PlannerStep,
	updatedArtifacts: readonly PlannerBehaviorArtifact[],
	requiredArtifacts: readonly PlannerBehaviorArtifact[],
	extraTools: readonly string[] = [],
): PlannerStageStepBehavior {
	return behavior(stage, step, {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts,
		updatedArtifacts,
		requiredGates: [],
		expectedTools: ["planner_status", ...extraTools],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	});
}

function compactBehavior(
	stage: PlannerStage,
	step: PlannerStep,
	requiredArtifacts: readonly PlannerBehaviorArtifact[],
): PlannerStageStepBehavior {
	return behavior(stage, step, {
		projectAccess: "none",
		actions: ["compact"],
		requiredArtifacts,
		updatedArtifacts: ["state.json"],
		requiredGates: [],
		expectedTools: ["planner_request_compact", "planner_complete_compact"],
		commitPolicy: "forbidden",
		compactPolicy: "request_required",
	});
}

function enterBehavior(
	stage: PlannerStage,
	step: PlannerStep,
	requiredGates: readonly PlannerBehaviorGate[],
): PlannerStageStepBehavior {
	return behavior(stage, step, {
		projectAccess: "none",
		actions: ["state_transition"],
		requiredArtifacts: ["state.json"],
		updatedArtifacts: ["state.json"],
		requiredGates,
		expectedTools: ["planner_finish_step"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	});
}

function recoveryBehavior(
	step: PlannerStep,
	updatedArtifacts: readonly PlannerBehaviorArtifact[],
): PlannerStageStepBehavior {
	return behavior("recovery", step, {
		projectAccess: "read_only",
		actions: ["planner_git", "inspect_project"],
		requiredArtifacts: ["state.json"],
		updatedArtifacts,
		requiredGates: [],
		expectedTools: ["planner_recovery_inspect"],
		commitPolicy: "forbidden",
		compactPolicy: "not_allowed",
	});
}

function allowBehaviorTool(
	tool: PlannerWrapperTool,
): PlannerStageBehaviorToolDecision {
	return { allow: true, tool, reason: null };
}

function blockBehaviorTool(
	tool: PlannerWrapperTool,
	reason: string,
): PlannerStageBehaviorToolDecision {
	return { allow: false, tool, reason };
}

function isRecoveryTool(tool: PlannerWrapperTool): boolean {
	return (
		tool === "planner_recovery_inspect" || tool === "planner_recovery_resume"
	);
}

function isStateChangingGitTool(tool: PlannerWrapperTool): boolean {
	return (
		tool === "planner_git_init" ||
		tool === "planner_git_create_task_branch" ||
		tool === "planner_git_create_refactor_branch" ||
		tool === "planner_git_merge_refactor_to_task" ||
		tool === "planner_git_merge_task_to_plan"
	);
}

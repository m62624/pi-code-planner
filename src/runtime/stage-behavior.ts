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
	| "write_memory"
	| "verify_memory"
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
	| "plan.md"
	| "discovery.md"
	| "questions.md"
	| "decisions.md"
	| "project_patterns.md"
	| "memory/files/index.jsonl"
	| "memory/symbols/index.jsonl"
	| "memory/relations/index.jsonl"
	| "memory/dirty.json"
	| "memory/latest-checkpoint.json"
	| "task.json"
	| "task.md"
	| "tdd.md"
	| "tests.md"
	| "implementation.md"
	| "verify.md"
	| "experiment.json"
	| "experiment/summary.md"
	| "final_summary.md";

export type PlannerBehaviorGate =
	| "project_resolved"
	| "git_available"
	| "storage_ready"
	| "worktree_location_selected"
	| "plan_record_exists"
	| "plan_worktree_exists"
	| "memory_indexed"
	| "memory_verified"
	| "memory_checkpoint_synced"
	| "plan_verified"
	| "active_task_selected"
	| "task_branch_ready"
	| "tdd_plan_written"
	| "tests_written_first"
	| "failing_signal_recorded"
	| "experiment_branch_ready"
	| "experiment_committed"
	| "experiment_summarized"
	| "experiment_selected"
	| "experiment_merged"
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
	expectedTools: readonly string[];
	commitPolicy: "forbidden" | "allowed_if_dirty" | "required_if_dirty";
	memoryPolicy:
		| "not_required"
		| "read_first"
		| "write_entries"
		| "verify_and_sync"
		| "sync_after_git";
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
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
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
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),
	prepare_storage: behavior("init", "prepare_storage", {
		projectAccess: "none",
		actions: ["write_artifacts"],
		requiredArtifacts: [],
		updatedArtifacts: ["project.json"],
		requiredGates: ["git_available"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
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
		memoryPolicy: "not_required",
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
			"project_patterns.md",
			"memory/files/index.jsonl",
			"memory/symbols/index.jsonl",
			"memory/relations/index.jsonl",
			"memory/latest-checkpoint.json",
		],
		requiredGates: ["worktree_location_selected"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),
	create_plan_worktree: behavior("init", "create_plan_worktree", {
		projectAccess: "none",
		actions: ["planner_git"],
		requiredArtifacts: ["plan.json", "state.json"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["plan_record_exists"],
		expectedTools: ["planner_git_inspect"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),
	enter_discovery: behavior("init", "enter_discovery", {
		projectAccess: "none",
		actions: ["state_transition"],
		requiredArtifacts: ["state.json"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["plan_worktree_exists"],
		expectedTools: ["planner_advance_step"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),

	read_project: behavior("discovery", "read_project", {
		projectAccess: "read_only",
		actions: ["inspect_project", "write_artifacts"],
		requiredArtifacts: ["plan.md"],
		updatedArtifacts: ["discovery.md"],
		requiredGates: ["plan_worktree_exists"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),
	write_project_patterns: behavior("discovery", "write_project_patterns", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts", "write_memory"],
		requiredArtifacts: ["discovery.md"],
		updatedArtifacts: ["project_patterns.md"],
		requiredGates: [],
		expectedTools: ["planner_memory_write_batch"],
		commitPolicy: "forbidden",
		memoryPolicy: "write_entries",
		compactPolicy: "not_allowed",
	}),
	write_file_index: behavior("discovery", "write_file_index", {
		projectAccess: "planner_artifacts",
		actions: ["write_memory"],
		requiredArtifacts: ["project_patterns.md"],
		updatedArtifacts: ["memory/files/index.jsonl"],
		requiredGates: [],
		expectedTools: ["planner_memory_write_batch"],
		commitPolicy: "forbidden",
		memoryPolicy: "write_entries",
		compactPolicy: "not_allowed",
	}),
	write_symbols: behavior("discovery", "write_symbols", {
		projectAccess: "planner_artifacts",
		actions: ["write_memory"],
		requiredArtifacts: ["memory/files/index.jsonl"],
		updatedArtifacts: ["memory/symbols/index.jsonl"],
		requiredGates: [],
		expectedTools: ["planner_memory_write_batch"],
		commitPolicy: "forbidden",
		memoryPolicy: "write_entries",
		compactPolicy: "not_allowed",
	}),
	write_relations: behavior("discovery", "write_relations", {
		projectAccess: "planner_artifacts",
		actions: ["write_memory"],
		requiredArtifacts: ["memory/symbols/index.jsonl"],
		updatedArtifacts: ["memory/relations/index.jsonl"],
		requiredGates: [],
		expectedTools: ["planner_memory_write_batch"],
		commitPolicy: "forbidden",
		memoryPolicy: "write_entries",
		compactPolicy: "not_allowed",
	}),
	write_questions: behavior("discovery", "write_questions", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts: ["discovery.md", "memory/relations/index.jsonl"],
		updatedArtifacts: ["questions.md"],
		requiredGates: ["memory_indexed"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),
	verify_memory: behavior("discovery", "verify_memory", {
		projectAccess: "read_only",
		actions: ["verify_memory"],
		requiredArtifacts: [
			"memory/files/index.jsonl",
			"memory/symbols/index.jsonl",
			"memory/relations/index.jsonl",
		],
		updatedArtifacts: ["memory/latest-checkpoint.json", "memory/dirty.json"],
		requiredGates: ["memory_indexed"],
		expectedTools: [
			"planner_memory_inspect",
			"planner_memory_verify",
			"planner_memory_sync_checkpoint",
		],
		commitPolicy: "forbidden",
		memoryPolicy: "verify_and_sync",
		compactPolicy: "not_allowed",
	}),
	compact_discovery: compactBehavior("discovery", "compact_discovery", [
		"discovery.md",
		"project_patterns.md",
		"memory/latest-checkpoint.json",
	]),
	enter_planning: enterBehavior("discovery", "enter_planning", [
		"memory_verified",
		"memory_checkpoint_synced",
	]),

	read_memory: behavior("planning", "read_memory", {
		projectAccess: "planner_artifacts",
		actions: ["inspect_project"],
		requiredArtifacts: [
			"project_patterns.md",
			"memory/files/index.jsonl",
			"memory/symbols/index.jsonl",
			"memory/relations/index.jsonl",
		],
		updatedArtifacts: [],
		requiredGates: ["memory_checkpoint_synced"],
		expectedTools: ["planner_memory_inspect"],
		commitPolicy: "forbidden",
		memoryPolicy: "read_first",
		compactPolicy: "not_allowed",
	}),
	draft_plan: artifactBehavior(
		"planning",
		"draft_plan",
		["plan.md"],
		["project_patterns.md"],
	),
	split_tasks: artifactBehavior(
		"planning",
		"split_tasks",
		["plan.md"],
		["plan.md"],
	),
	write_task_files: artifactBehavior(
		"planning",
		"write_task_files",
		["task.json", "task.md"],
		["plan.md"],
	),
	verify_plan: behavior("planning", "verify_plan", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts: ["plan.md", "task.json", "task.md"],
		updatedArtifacts: ["decisions.md"],
		requiredGates: [],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		memoryPolicy: "read_first",
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
		memoryPolicy: "read_first",
		compactPolicy: "not_allowed",
	}),
	write_tdd_plan: behavior("execution", "write_tdd_plan", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts: ["task.md"],
		updatedArtifacts: ["tdd.md"],
		requiredGates: ["active_task_selected", "task_branch_ready"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		memoryPolicy: "read_first",
		compactPolicy: "not_allowed",
	}),
	write_tests: behavior("execution", "write_tests", {
		projectAccess: "test_edits",
		actions: ["write_tests"],
		requiredArtifacts: ["tdd.md"],
		updatedArtifacts: ["tests.md"],
		requiredGates: ["tdd_plan_written"],
		expectedTools: ["planner_git_inspect", "planner_git_commit"],
		commitPolicy: "allowed_if_dirty",
		memoryPolicy: "read_first",
		compactPolicy: "not_allowed",
	}),
	run_failing_tests: behavior("execution", "run_failing_tests", {
		projectAccess: "checks_only",
		actions: ["run_checks", "write_artifacts"],
		requiredArtifacts: ["tests.md"],
		updatedArtifacts: ["verify.md"],
		requiredGates: ["tests_written_first"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),
	start_experiments: behavior("execution", "start_experiments", {
		projectAccess: "planner_artifacts",
		actions: ["planner_git", "write_artifacts"],
		requiredArtifacts: ["verify.md"],
		updatedArtifacts: ["experiment.json"],
		requiredGates: ["failing_signal_recorded"],
		expectedTools: ["planner_git_create_experiment_branch"],
		commitPolicy: "forbidden",
		memoryPolicy: "read_first",
		compactPolicy: "not_allowed",
	}),
	run_experiment: behavior("execution", "run_experiment", {
		projectAccess: "production_edits",
		actions: ["write_production", "run_checks", "planner_git", "write_memory"],
		requiredArtifacts: ["experiment.json", "tdd.md", "tests.md"],
		updatedArtifacts: ["implementation.md", "memory/dirty.json"],
		requiredGates: ["experiment_branch_ready"],
		expectedTools: ["planner_git_commit", "planner_memory_write_batch"],
		commitPolicy: "required_if_dirty",
		memoryPolicy: "sync_after_git",
		compactPolicy: "not_allowed",
	}),
	summarize_experiment: behavior("execution", "summarize_experiment", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts: ["implementation.md", "memory/latest-checkpoint.json"],
		updatedArtifacts: ["experiment/summary.md"],
		requiredGates: ["experiment_committed", "memory_checkpoint_synced"],
		expectedTools: ["planner_git_inspect", "planner_git_commit"],
		commitPolicy: "allowed_if_dirty",
		memoryPolicy: "read_first",
		compactPolicy: "not_allowed",
	}),
	compact_experiment: compactBehavior("execution", "compact_experiment", [
		"experiment/summary.md",
		"memory/latest-checkpoint.json",
	]),
	select_experiment: behavior("execution", "select_experiment", {
		projectAccess: "planner_artifacts",
		actions: ["planner_git"],
		requiredArtifacts: ["experiment/summary.md"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["experiment_summarized"],
		expectedTools: ["planner_git_select_experiment"],
		commitPolicy: "forbidden",
		memoryPolicy: "read_first",
		compactPolicy: "not_allowed",
	}),
	merge_best_experiment: behavior("execution", "merge_best_experiment", {
		projectAccess: "none",
		actions: ["planner_git", "write_memory"],
		requiredArtifacts: ["state.json", "memory/latest-checkpoint.json"],
		updatedArtifacts: ["state.json", "memory/dirty.json"],
		requiredGates: ["experiment_selected"],
		expectedTools: [
			"planner_git_merge_selected_experiment",
			"planner_memory_write_batch",
		],
		commitPolicy: "forbidden",
		memoryPolicy: "sync_after_git",
		compactPolicy: "not_allowed",
	}),
	refactor_task: behavior("execution", "refactor_task", {
		projectAccess: "production_edits",
		actions: ["refactor", "run_checks", "planner_git", "write_memory"],
		requiredArtifacts: ["implementation.md", "tests.md"],
		updatedArtifacts: ["implementation.md", "verify.md", "memory/dirty.json"],
		requiredGates: ["experiment_merged"],
		expectedTools: ["planner_git_commit", "planner_memory_write_batch"],
		commitPolicy: "allowed_if_dirty",
		memoryPolicy: "sync_after_git",
		compactPolicy: "not_allowed",
	}),
	run_final_tests: behavior("execution", "run_final_tests", {
		projectAccess: "checks_only",
		actions: ["run_checks", "write_artifacts", "planner_git", "write_memory"],
		requiredArtifacts: ["tests.md", "verify.md"],
		updatedArtifacts: ["verify.md", "memory/latest-checkpoint.json"],
		requiredGates: ["refactor_checked"],
		expectedTools: ["planner_git_commit", "planner_memory_sync_checkpoint"],
		commitPolicy: "allowed_if_dirty",
		memoryPolicy: "verify_and_sync",
		compactPolicy: "not_allowed",
	}),
	merge_task_to_plan: behavior("execution", "merge_task_to_plan", {
		projectAccess: "none",
		actions: ["planner_git", "write_memory"],
		requiredArtifacts: ["verify.md", "memory/latest-checkpoint.json"],
		updatedArtifacts: ["state.json", "memory/dirty.json"],
		requiredGates: ["final_tests_passed", "memory_checkpoint_synced"],
		expectedTools: [
			"planner_git_merge_task_to_plan",
			"planner_memory_write_batch",
		],
		commitPolicy: "forbidden",
		memoryPolicy: "sync_after_git",
		compactPolicy: "not_allowed",
	}),
	compact_task: compactBehavior("execution", "compact_task", [
		"task.md",
		"verify.md",
		"memory/latest-checkpoint.json",
	]),
	select_next_task: behavior("execution", "select_next_task", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts", "state_transition"],
		requiredArtifacts: ["plan.md", "task.json", "verify.md"],
		updatedArtifacts: ["state.json", "decisions.md"],
		requiredGates: ["task_merged_to_plan"],
		expectedTools: ["planner_complete_step"],
		commitPolicy: "forbidden",
		memoryPolicy: "read_first",
		compactPolicy: "not_allowed",
	}),

	verify_plan_branch: behavior("finalize", "verify_plan_branch", {
		projectAccess: "checks_only",
		actions: ["run_checks", "planner_git"],
		requiredArtifacts: ["plan.md", "memory/latest-checkpoint.json"],
		updatedArtifacts: ["verify.md"],
		requiredGates: ["next_task_decided"],
		expectedTools: ["planner_git_inspect"],
		commitPolicy: "forbidden",
		memoryPolicy: "verify_and_sync",
		compactPolicy: "not_allowed",
	}),
	write_final_summary: behavior("finalize", "write_final_summary", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts: ["plan.md", "verify.md"],
		updatedArtifacts: ["final_summary.md"],
		requiredGates: ["plan_branch_verified"],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		memoryPolicy: "read_first",
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
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),
	await_user_acceptance: behavior("done", "await_user_acceptance", {
		projectAccess: "user_communication",
		actions: ["ask_user"],
		requiredArtifacts: ["final_summary.md"],
		updatedArtifacts: ["decisions.md"],
		requiredGates: ["user_acceptance_required"],
		expectedTools: ["planner_complete_step"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),
	handle_change_request: behavior("done", "handle_change_request", {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts", "state_transition"],
		requiredArtifacts: ["decisions.md"],
		updatedArtifacts: ["plan.md", "decisions.md", "state.json"],
		requiredGates: ["user_acceptance_required"],
		expectedTools: ["planner_complete_step"],
		commitPolicy: "forbidden",
		memoryPolicy: "read_first",
		compactPolicy: "not_allowed",
	}),
	prepare_output_branch: behavior("done", "prepare_output_branch", {
		projectAccess: "none",
		actions: ["planner_git"],
		requiredArtifacts: ["final_summary.md"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["user_acceptance_required"],
		expectedTools: ["planner_git_export_plan_to_output"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),
	merge_or_export_result: behavior("done", "merge_or_export_result", {
		projectAccess: "none",
		actions: ["planner_git"],
		requiredArtifacts: ["state.json"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["output_branch_ready"],
		expectedTools: ["planner_git_export_plan_to_output"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),
	cleanup_worktree: behavior("done", "cleanup_worktree", {
		projectAccess: "none",
		actions: ["planner_git", "cleanup"],
		requiredArtifacts: ["state.json"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["output_branch_ready"],
		expectedTools: [
			"planner_git_remove_plan_worktree",
			"planner_git_cleanup_managed_branches",
		],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
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
		memoryPolicy: "not_required",
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
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),

	read_state: recoveryBehavior("read_state", ["state.json"]),
	inspect_git: recoveryBehavior("inspect_git", ["state.json"]),
	compare_expected_actual: recoveryBehavior("compare_expected_actual", [
		"state.json",
		"memory/latest-checkpoint.json",
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
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),
	repair_or_resume: behavior("recovery", "repair_or_resume", {
		projectAccess: "none",
		actions: ["state_transition"],
		requiredArtifacts: ["state.json", "decisions.md"],
		updatedArtifacts: ["state.json"],
		requiredGates: ["user_repair_decision"],
		expectedTools: ["planner_recovery_resume"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	}),
} as const satisfies Record<PlannerStep, PlannerStageStepBehavior>;

export function getPlannerStageStepBehavior(input: {
	stage: PlannerStage;
	step: PlannerStep;
}): PlannerStageStepBehavior {
	const behavior = PLANNER_STAGE_BEHAVIOR[input.step];
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

	if (isMemoryWriteTool(input.tool)) {
		return input.behavior.memoryPolicy === "write_entries" ||
			input.behavior.memoryPolicy === "sync_after_git"
			? allowBehaviorTool(input.tool)
			: blockBehaviorTool(
					input.tool,
					`Stage behavior does not allow memory writes at ${input.behavior.stage}/${input.behavior.step}.`,
				);
	}

	if (isMemoryVerifyOrSyncTool(input.tool)) {
		return input.behavior.memoryPolicy === "verify_and_sync" ||
			input.behavior.memoryPolicy === "sync_after_git"
			? allowBehaviorTool(input.tool)
			: blockBehaviorTool(
					input.tool,
					`Stage behavior does not allow memory verification/sync at ${input.behavior.stage}/${input.behavior.step}.`,
				);
	}

	if (isMemoryReadTool(input.tool)) {
		return input.behavior.memoryPolicy === "not_required" &&
			!input.behavior.expectedTools.includes(input.tool)
			? blockBehaviorTool(
					input.tool,
					`Stage behavior does not require planner memory access at ${input.behavior.stage}/${input.behavior.step}.`,
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
): PlannerStageStepBehavior {
	return behavior(stage, step, {
		projectAccess: "planner_artifacts",
		actions: ["write_artifacts"],
		requiredArtifacts,
		updatedArtifacts,
		requiredGates: [],
		expectedTools: ["planner_status"],
		commitPolicy: "forbidden",
		memoryPolicy: "read_first",
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
		requiredGates: ["memory_checkpoint_synced"],
		expectedTools: ["planner_request_compact", "planner_complete_compact"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
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
		expectedTools: ["planner_advance_step"],
		commitPolicy: "forbidden",
		memoryPolicy: "not_required",
		compactPolicy: "not_allowed",
	});
}

function recoveryBehavior(
	step: PlannerStep,
	updatedArtifacts: readonly PlannerBehaviorArtifact[],
): PlannerStageStepBehavior {
	return behavior("recovery", step, {
		projectAccess: "read_only",
		actions: ["planner_git", "verify_memory"],
		requiredArtifacts: ["state.json"],
		updatedArtifacts,
		requiredGates: [],
		expectedTools: ["planner_recovery_inspect"],
		commitPolicy: "forbidden",
		memoryPolicy: "read_first",
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

function isMemoryReadTool(tool: PlannerWrapperTool): boolean {
	return tool === "planner_memory_inspect";
}

function isMemoryWriteTool(tool: PlannerWrapperTool): boolean {
	return (
		tool === "planner_memory_apply_freshness" ||
		tool === "planner_memory_write_batch"
	);
}

function isMemoryVerifyOrSyncTool(tool: PlannerWrapperTool): boolean {
	return (
		tool === "planner_memory_verify" ||
		tool === "planner_memory_sync_checkpoint"
	);
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
		tool === "planner_git_create_experiment_branch" ||
		tool === "planner_git_select_experiment" ||
		tool === "planner_git_merge_selected_experiment" ||
		tool === "planner_git_create_refactor_branch" ||
		tool === "planner_git_merge_refactor_to_task" ||
		tool === "planner_git_merge_task_to_plan" ||
		tool === "planner_git_export_plan_to_output" ||
		tool === "planner_git_remove_plan_worktree" ||
		tool === "planner_git_cleanup_managed_branches"
	);
}

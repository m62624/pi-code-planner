import { SCHEMA_VERSION } from "../constants";

export type PlanSummaryStatus = "active" | "paused" | "done" | "broken";
export type PlanStatus = "draft" | "active" | "paused" | "done" | "broken";
export type TaskStatus = "pending" | "active" | "done" | "blocked";

export type PlannerStage =
	| "init"
	| "discovery"
	| "planning"
	| "execution"
	| "finalize"
	| "done"
	| "recovery";

export type InitStep =
	| "check_project"
	| "check_git"
	| "prepare_storage"
	| "choose_worktree_location"
	| "create_plan_record"
	| "create_plan_worktree"
	| "enter_discovery";

export type DiscoveryStep =
	| "read_project"
	| "write_project_patterns"
	| "write_file_index"
	| "write_symbols"
	| "write_relations"
	| "write_questions"
	| "verify_memory"
	| "compact_discovery"
	| "enter_planning";

export type PlanningStep =
	| "read_memory"
	| "draft_plan"
	| "split_tasks"
	| "write_task_files"
	| "verify_plan"
	| "compact_planning"
	| "enter_execution";

export type ExecutionStep =
	| "prepare_task"
	| "write_tdd_plan"
	| "write_tests"
	| "run_failing_tests"
	| "start_experiments"
	| "run_experiment"
	| "summarize_experiment"
	| "compact_experiment"
	| "select_experiment"
	| "merge_best_experiment"
	| "refactor_task"
	| "run_final_tests"
	| "merge_task_to_plan"
	| "compact_task"
	| "select_next_task";

export type FinalizeStep =
	| "verify_plan_branch"
	| "write_final_summary"
	| "compact_finalize"
	| "enter_done";

export type DoneStep =
	| "present_result"
	| "await_user_acceptance"
	| "handle_change_request"
	| "prepare_output_branch"
	| "merge_or_export_result"
	| "cleanup_worktree"
	| "mark_done"
	| "cleanup_plan_files";

export type RecoveryStep =
	| "read_state"
	| "inspect_git"
	| "compare_expected_actual"
	| "classify_recovery"
	| "ask_user_if_destructive"
	| "repair_or_resume";

export type PlannerStep =
	| InitStep
	| DiscoveryStep
	| PlanningStep
	| ExecutionStep
	| FinalizeStep
	| RecoveryStep
	| DoneStep;

export const PLANNER_STAGE_STEPS = {
	init: [
		"check_project",
		"check_git",
		"prepare_storage",
		"choose_worktree_location",
		"create_plan_record",
		"create_plan_worktree",
		"enter_discovery",
	],
	discovery: [
		"read_project",
		"write_project_patterns",
		"write_file_index",
		"write_symbols",
		"write_relations",
		"write_questions",
		"verify_memory",
		"compact_discovery",
		"enter_planning",
	],
	planning: [
		"read_memory",
		"draft_plan",
		"split_tasks",
		"write_task_files",
		"verify_plan",
		"compact_planning",
		"enter_execution",
	],
	execution: [
		"prepare_task",
		"write_tdd_plan",
		"write_tests",
		"run_failing_tests",
		"start_experiments",
		"run_experiment",
		"summarize_experiment",
		"compact_experiment",
		"select_experiment",
		"merge_best_experiment",
		"refactor_task",
		"run_final_tests",
		"merge_task_to_plan",
		"compact_task",
		"select_next_task",
	],
	finalize: [
		"verify_plan_branch",
		"write_final_summary",
		"compact_finalize",
		"enter_done",
	],
	done: [
		"present_result",
		"await_user_acceptance",
		"handle_change_request",
		"prepare_output_branch",
		"merge_or_export_result",
		"cleanup_worktree",
		"mark_done",
		"cleanup_plan_files",
	],
	recovery: [
		"read_state",
		"inspect_git",
		"compare_expected_actual",
		"classify_recovery",
		"ask_user_if_destructive",
		"repair_or_resume",
	],
} as const satisfies Record<PlannerStage, readonly PlannerStep[]>;

export type StepStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "blocked";

export type MemoryUpdateReason =
	| "planner_commit"
	| "planner_merge"
	| "external_commit"
	| "manual_checkout"
	| "rebase_or_history_rewrite"
	| "file_hash_changed";

export interface ProjectPlanSummary {
	planId: string;
	title: string;
	status: PlanSummaryStatus;
}

export interface ProjectRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	projectId: string;
	projectRoot: string;
	displayName: string;
	activePlanId: string | null;
	plans: ProjectPlanSummary[];
}

export interface PlanTaskSummary {
	taskId: string;
	title: string;
	status: TaskStatus;
}

export interface PlanRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	planId: string;
	title: string;
	status: PlanStatus;
	tasks: PlanTaskSummary[];
}

export interface PlanBranches {
	base: string;
	plan: string;
	currentTask: string | null;
	currentExperiment: string | null;
	selectedExperiment: string | null;
}

export interface MergeTargets {
	experimentToTask: string | null;
	taskToPlan: string | null;
	planToOutput: string | null;
}

export interface ManagedTaskBranchRegistry {
	task: string | null;
	experiments: string[];
	selectedExperiment: string | null;
	refactor: string | null;
}

export interface ManagedBranchRegistry {
	tasks: Record<string, ManagedTaskBranchRegistry>;
}

export interface PlanStateRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	stage: PlannerStage;
	step: PlannerStep;
	stepStatus: StepStatus;
	nextStep: PlannerStep | null;
	activeTaskId: string | null;
	activeExperimentId: string | null;
	worktreePath: string | null;
	branches: PlanBranches;
	branchRegistry: ManagedBranchRegistry;
	currentBranch: string | null;
	mergeTargets: MergeTargets;
	lastCheckpointCommit: string | null;
	requiresMemoryUpdate: boolean;
	memoryUpdateReason: MemoryUpdateReason | null;
	requiresCompact: boolean;
	requiresUserDecision: boolean;
	broken: boolean;
	brokenReason: string | null;
	blockedReason: string | null;
}

export function createEmptyProjectRecord(input: {
	projectId: string;
	projectRoot: string;
	displayName: string;
}): ProjectRecord {
	return {
		schemaVersion: SCHEMA_VERSION,
		projectId: input.projectId,
		projectRoot: input.projectRoot,
		displayName: input.displayName,
		activePlanId: null,
		plans: [],
	};
}

export function createPlanRecord(input: {
	planId: string;
	title: string;
	status?: PlanStatus;
	tasks?: PlanTaskSummary[];
}): PlanRecord {
	return {
		schemaVersion: SCHEMA_VERSION,
		planId: input.planId,
		title: input.title,
		status: input.status ?? "draft",
		tasks: input.tasks ?? [],
	};
}

export function createInitialPlanState(input: {
	baseBranch: string;
	planBranch: string;
	worktreePath?: string | null;
}): PlanStateRecord {
	return {
		schemaVersion: SCHEMA_VERSION,
		stage: "init",
		step: "check_project",
		stepStatus: "pending",
		nextStep: null,
		activeTaskId: null,
		activeExperimentId: null,
		worktreePath: input.worktreePath ?? null,
		branches: {
			base: input.baseBranch,
			plan: input.planBranch,
			currentTask: null,
			currentExperiment: null,
			selectedExperiment: null,
		},
		branchRegistry: { tasks: {} },
		currentBranch: null,
		mergeTargets: {
			experimentToTask: null,
			taskToPlan: null,
			planToOutput: null,
		},
		lastCheckpointCommit: null,
		requiresMemoryUpdate: false,
		memoryUpdateReason: null,
		requiresCompact: false,
		requiresUserDecision: false,
		broken: false,
		brokenReason: null,
		blockedReason: null,
	};
}

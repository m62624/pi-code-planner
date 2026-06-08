import { SCHEMA_VERSION } from "../constants";

export type PlanSummaryStatus = "active" | "paused" | "done" | "broken";
export type PlanStatus = "draft" | "active" | "paused" | "done" | "broken";
export type TaskStatus = "pending" | "active" | "done" | "blocked";

export type PlannerStage =
	| "init"
	| "intake"
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
	| "enter_intake";

export type IntakeStep = "draft_goal" | "await_goal_approval";

export type DiscoveryStep =
	| "scan_project_structure"
	| "write_questions"
	| "compact_discovery"
	| "enter_planning";

export type PlanningStep =
	| "read_context"
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
	| "implement_task"
	| "refactor_task"
	| "run_final_tests"
	| "merge_task_to_plan"
	| "compact_task"
	| "select_next_task";

export type FinalizeStep =
	| "verify_plan_branch"
	| "doubt_review"
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
	| IntakeStep
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
		"enter_intake",
	],
	intake: ["draft_goal", "await_goal_approval"],
	discovery: [
		"scan_project_structure",
		"write_questions",
		"compact_discovery",
		"enter_planning",
	],
	planning: [
		"read_context",
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
		"implement_task",
		"refactor_task",
		"run_final_tests",
		"merge_task_to_plan",
		"compact_task",
		"select_next_task",
	],
	finalize: [
		"verify_plan_branch",
		"doubt_review",
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

export const PLANNER_STAGE_VALUES = Object.keys(
	PLANNER_STAGE_STEPS,
) as PlannerStage[];

export const PLANNER_STEP_VALUES = Object.values(PLANNER_STAGE_STEPS).flatMap(
	(steps) => [...steps],
) as PlannerStep[];

export type StepStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "blocked";

export interface ProjectPlanSummary {
	planId: string;
	title: string;
	description?: string;
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

export interface TaskRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	taskId: string;
	title: string;
	status: TaskStatus;
	objective: string;
	scope: string[];
	acceptanceCriteria: string[];
}

export interface PlanRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	planId: string;
	title: string;
	description?: string;
	status: PlanStatus;
	tasks: PlanTaskSummary[];
}

export interface ActivePlanBranches {
	base: string;
	plan: string;
	currentTask: string | null;
}

export interface MergeTargets {
	taskToPlan: string | null;
	planToOutput: string | null;
}

export interface ManagedTaskBranchRegistry {
	task: string | null;
	refactor: string | null;
}

export interface ManagedBranchRegistry {
	tasks: Record<string, ManagedTaskBranchRegistry>;
}

export interface PlannerCompactBoundaries {
	stage: boolean;
	task: boolean;
}

export interface PlannerTimerCheckpoint {
	stage: PlannerStage;
	enteredAt: number;
	activeMs: number;
}

export interface PlannerTimerState {
	startedAt: number;
	lastSyncedAt: number;
	activeMs: number;
	pausedAt: number | null;
	finishedAt: number | null;
	stage: PlannerStage;
	stageStartedAt: number;
	checkpoints: PlannerTimerCheckpoint[];
}

export interface PlanStateRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	stage: PlannerStage;
	step: PlannerStep;
	stepStatus: StepStatus;
	nextStep: PlannerStep | null;
	activeTaskId: string | null;
	worktreePath: string | null;
	activeBranches: ActivePlanBranches;
	managedBranches: ManagedBranchRegistry;
	currentBranch: string | null;
	mergeTargets: MergeTargets;
	questionsSubmitted: boolean;
	questionsResolved: boolean;
	compactBoundaries: PlannerCompactBoundaries;
	lastPlannerToolCallAt: number | null;
	lastIdleWakeAt: number | null;
	idleWakeInFlight: boolean;
	lastStuckReportPath: string | null;
	lastStuckAttemptId: string | null;
	debugSessionId: string | null;
	debugArtifactsDir: string | null;
	debugStrategyPath: string | null;
	activeDebugProbeId: string | null;
	debugCleanupRequired: boolean;
	timer: PlannerTimerState | null;
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
	description?: string;
	status?: PlanStatus;
	tasks?: PlanTaskSummary[];
}): PlanRecord {
	return {
		schemaVersion: SCHEMA_VERSION,
		planId: input.planId,
		title: input.title,
		...(input.description ? { description: input.description } : {}),
		status: input.status ?? "draft",
		tasks: input.tasks ?? [],
	};
}

export function createInitialPlanState(input: {
	baseBranch: string;
	planBranch: string;
	worktreePath?: string | null;
	compactBoundaries?: PlannerCompactBoundaries;
}): PlanStateRecord {
	return {
		schemaVersion: SCHEMA_VERSION,
		stage: "init",
		step: "check_project",
		stepStatus: "pending",
		nextStep: null,
		activeTaskId: null,
		worktreePath: input.worktreePath ?? null,
		activeBranches: {
			base: input.baseBranch,
			plan: input.planBranch,
			currentTask: null,
		},
		managedBranches: { tasks: {} },
		currentBranch: null,
		mergeTargets: {
			taskToPlan: null,
			planToOutput: null,
		},
		questionsSubmitted: false,
		questionsResolved: false,
		compactBoundaries: input.compactBoundaries ?? {
			stage: true,
			task: false,
		},
		lastPlannerToolCallAt: null,
		lastIdleWakeAt: null,
		idleWakeInFlight: false,
		lastStuckReportPath: null,
		lastStuckAttemptId: null,
		debugSessionId: null,
		debugArtifactsDir: null,
		debugStrategyPath: null,
		activeDebugProbeId: null,
		debugCleanupRequired: false,
		timer: null,
		requiresCompact: false,
		requiresUserDecision: false,
		broken: false,
		brokenReason: null,
		blockedReason: null,
	};
}

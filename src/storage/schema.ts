import { SCHEMA_VERSION } from "../constants";

export type PlanSummaryStatus = "active" | "paused" | "done" | "broken";
export type PlanStatus = "draft" | "active" | "paused" | "done" | "broken";
export type TaskStatus = "pending" | "active" | "done" | "blocked";
export type PlanCreationMethod = "create" | "improve";
export type PlanCompatibilityMode = "additive" | "breaking";

export type PlannerStage =
	| "init"
	| "intake"
	| "discovery"
	| "spec"
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

// The window-management compact steps (compact_discovery/spec/planning/task and
// compact_finalize) were removed from the flow: the proactive turn_end monitor
// (index.ts) now handles context pressure on any step, so the model no longer
// pays a finish_step round-trip to walk through a boundary that mostly no-ops
// below the token floor. The literals are gone from these unions; a persisted
// state.json parked at one is remapped forward by normalizePlanState
// (state-store.ts), which matches the raw step string at the read boundary.
// compact_before_doubt survives as a deliberate (forced) confidence reset.
export type DiscoveryStep =
	| "scan_project_structure"
	| "write_questions"
	| "enter_planning";

// SDD spec stage (docs/sdd/SPEC.md §6). Note: the exit step is named
// finish_spec, NOT enter_planning as SPEC.md §6.1 originally sketched —
// step names must be globally unique across stages (state-machine.ts
// buildStepToStageMap throws otherwise) and discovery already owns
// enter_planning.
export type SpecStep =
	| "draft_requirements"
	| "elicit_gaps"
	| "verify_spec"
	| "finish_spec";

export type PlanningStep =
	| "read_context"
	| "draft_plan"
	| "split_tasks"
	| "write_task_files"
	| "verify_plan"
	| "consistency_check"
	| "enter_execution";

export type ExecutionStep =
	| "prepare_task"
	| "write_tdd_plan"
	| "write_tests"
	| "run_failing_tests"
	| "implement_task"
	| "contract_check"
	| "refactor_task"
	| "run_final_tests"
	| "capture_skill"
	| "merge_task_to_plan"
	| "select_next_task";

export type FinalizeStep =
	| "verify_plan_branch"
	| "compact_before_doubt"
	| "doubt_review"
	| "write_final_summary"
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
	| SpecStep
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
	discovery: ["scan_project_structure", "write_questions", "enter_planning"],
	spec: ["draft_requirements", "elicit_gaps", "verify_spec", "finish_spec"],
	planning: [
		"read_context",
		"draft_plan",
		"split_tasks",
		"write_task_files",
		"verify_plan",
		"consistency_check",
		"enter_execution",
	],
	execution: [
		"prepare_task",
		"write_tdd_plan",
		"write_tests",
		"run_failing_tests",
		"implement_task",
		"contract_check",
		"refactor_task",
		"run_final_tests",
		"capture_skill",
		"merge_task_to_plan",
		"select_next_task",
	],
	finalize: [
		"verify_plan_branch",
		"compact_before_doubt",
		"doubt_review",
		"write_final_summary",
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
	// Spec traceability (SDD): REQ-n ids from spec.json this task discharges.
	// Optional and defaulted to [] on read so legacy task.json files parse.
	requirements?: string[];
	// Build-order dependencies: taskIds this task depends on (foundations first).
	// The plan_coverage gate justifies a non-discharging task by having a
	// discharging task (transitively) depend on it — a setup task is not orphan
	// because it borrows a REQ, but because real work depends on it. Optional and
	// defaulted to [] on read so legacy task.json files parse.
	dependsOn?: string[];
	contractChain?: string[];
	relevantContracts?: string[];
	forbiddenAreas?: string[];
	domainDetails?: string[];
	commitHash?: string;
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

export type PlannerContractFinalPolicy = "ask" | "keep" | "remove";
export type PlannerContractFinalDecision = "pending" | "keep" | "remove";
export type PlannerContractCheckAction =
	| "no_update"
	| "upsert_existing"
	| "create_new";

export interface PlannerContractTouchedFile {
	path: string;
	existedBeforePlan: boolean;
	baselineSha256: string | null;
	baselinePath: string | null;
	currentSha256: string | null;
	changeKind: "created" | "updated" | "removed";
}

export interface PlannerContractPendingRead {
	path: string;
	cursor: number;
	reason: string;
}

export interface PlannerContractPendingUpsert {
	path: string;
	reason: string;
	taskId: string | null;
}

export interface PlannerContractCheckRecord {
	taskId: string | null;
	action: PlannerContractCheckAction;
	path: string | null;
	summary: string;
	checkedAt: number;
}

export interface PlannerContractChainRecord {
	targetPath: string;
	chain: string[];
	reason: string;
	updatedAt: number;
}

export interface PlannerContractSummaryRecord {
	path: string;
	purpose: string;
	childIndex: string[];
	stableContracts: string[];
	readFirst: string[];
	doNotTouchUnless: string[];
	domainDetails: string[];
	diagnostics: string[];
	updatedAt: number;
}

export interface PlannerContractsState {
	enabled: boolean;
	dirty: boolean;
	finalPolicy: PlannerContractFinalPolicy;
	finalDecision: PlannerContractFinalDecision;
	scanComplete: boolean;
	scanQueue: string[];
	discoveredPaths: string[];
	childContracts: Record<string, string[]>;
	diagnostics: string[];
	activeChains: PlannerContractChainRecord[];
	summaries: PlannerContractSummaryRecord[];
	pendingRead: PlannerContractPendingRead | null;
	pendingCheckTaskId: string | null;
	pendingUpsert: PlannerContractPendingUpsert | null;
	lastCheck: PlannerContractCheckRecord | null;
	touchedFiles: PlannerContractTouchedFile[];
}

// Persisted as state.json and read back through state-store.ts's
// normalizePlanState. Adding a field here is a 4-point change: this type,
// createInitialPlanState's default below, normalizePlanState's default, and
// a test — old plans on disk won't have the new field until normalized.
export interface PlanStateRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	creationMethod?: PlanCreationMethod;
	compatibilityMode?: PlanCompatibilityMode;
	stage: PlannerStage;
	step: PlannerStep;
	stepStatus: StepStatus;
	nextStep: PlannerStep | null;
	activeTaskId: string | null;
	worktreePath: string | null;
	// True when the plan record + request.md were persisted but the git worktree
	// could not be created yet (git missing, no repository, or a mid-bootstrap
	// failure). /planner-resume rebuilds the worktree from this state once git is
	// available, so a crash after the user typed the request never loses it.
	worktreeBootstrapPending?: boolean;
	activeBranches: ActivePlanBranches;
	managedBranches: ManagedBranchRegistry;
	currentBranch: string | null;
	mergeTargets: MergeTargets;
	questionsSubmitted: boolean;
	questionsResolved: boolean;
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
	contracts: PlannerContractsState;
	execRunning: boolean;
	requiresCompact: boolean;
	// One-shot: set true when a compact boundary completes, so the FIRST
	// planner_status after a compact re-inlines the full stage instruction (the
	// model's working memory was just wiped). Consumed — cleared — by that first
	// planner_status; subsequent statuses stay compact.
	pendingFullStatus?: boolean;
	// The stage whose full instruction was last inlined into planner_status. The
	// FIRST status on entering a new stage shows the full instruction (the model
	// does not know a stage's job until it reads it once); later statuses in the
	// same stage stay compact. Together with pendingFullStatus this makes the
	// status respect context yet always brief the model on unfamiliar ground.
	lastFullStatusStage?: PlannerStage | null;
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

export function createDefaultPlannerContractsState(): PlannerContractsState {
	return {
		enabled: true,
		dirty: false,
		finalPolicy: "ask",
		finalDecision: "pending",
		scanComplete: false,
		scanQueue: [],
		discoveredPaths: [],
		childContracts: {},
		diagnostics: [],
		activeChains: [],
		summaries: [],
		pendingRead: null,
		pendingCheckTaskId: null,
		pendingUpsert: null,
		lastCheck: null,
		touchedFiles: [],
	};
}

export function createInitialPlanState(input: {
	baseBranch: string;
	planBranch: string;
	worktreePath?: string | null;
	creationMethod?: PlanCreationMethod;
	compatibilityMode?: PlanCompatibilityMode;
}): PlanStateRecord {
	return {
		schemaVersion: SCHEMA_VERSION,
		creationMethod: input.creationMethod ?? "create",
		compatibilityMode: input.compatibilityMode ?? "additive",
		stage: "init",
		step: "check_project",
		stepStatus: "pending",
		nextStep: null,
		activeTaskId: null,
		worktreePath: input.worktreePath ?? null,
		worktreeBootstrapPending: false,
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
		contracts: createDefaultPlannerContractsState(),
		execRunning: false,
		requiresCompact: false,
		pendingFullStatus: false,
		lastFullStatusStage: null,
		requiresUserDecision: false,
		broken: false,
		brokenReason: null,
		blockedReason: null,
	};
}

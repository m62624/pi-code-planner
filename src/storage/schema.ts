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
	| "recovery"
	| "done";
export type StepStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "blocked";

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

export interface PlanStateRecord {
	schemaVersion: typeof SCHEMA_VERSION;
	stage: PlannerStage;
	step: string;
	stepStatus: StepStatus;
	nextStep: string | null;
	activeTaskId: string | null;
	activeExperimentId: string | null;
	worktreePath: string | null;
	branches: PlanBranches;
	currentBranch: string | null;
	mergeTargets: MergeTargets;
	lastCheckpointCommit: string | null;
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
		currentBranch: null,
		mergeTargets: {
			experimentToTask: null,
			taskToPlan: null,
			planToOutput: null,
		},
		lastCheckpointCommit: null,
		requiresCompact: false,
		requiresUserDecision: false,
		broken: false,
		brokenReason: null,
		blockedReason: null,
	};
}

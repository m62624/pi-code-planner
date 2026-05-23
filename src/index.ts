export { EXTENSION_NAME, SCHEMA_VERSION } from "./constants";
export {
	buildGitWorktreeAddArgs,
	buildGitWorktreeRemoveArgs,
	GitCommandError,
	NodeGitRunner,
} from "./git/node-runner";
export type {
	GitRunner,
	GitWorktreeAddInput,
	GitWorktreeRemoveInput,
} from "./git/runner";
export { DEFAULT_INSTRUCTIONS } from "./instructions/defaults";
export {
	getInstructionContent,
	readInstructionDefaultsFromDir,
	syncInstructionFiles,
} from "./instructions/manager";
export {
	createInstructionPaths,
	instructionFilePath,
} from "./instructions/paths";
export type {
	InstructionAppendSource,
	InstructionContent,
	InstructionDefaults,
	InstructionKey,
	InstructionPaths,
	SyncedInstructionFile,
} from "./instructions/schema";
export { INSTRUCTION_KEYS } from "./instructions/schema";
export type { GitignoreWorktreeRuleResult } from "./project-local/gitignore";
export {
	ensureProjectWorktreesIgnored,
	hasExactWorktreesIgnoreRule,
	PROJECT_WORKTREES_IGNORE_RULE,
} from "./project-local/gitignore";
export { createNodeFs, type PlannerFs } from "./storage/fs";
export { createProjectId, sanitizeIdPart } from "./storage/ids";
export {
	PlannerJsonError,
	readJson,
	readJsonIfExists,
	writeJson,
} from "./storage/json";
export type { PlanStoragePaths, ProjectStoragePaths } from "./storage/paths";
export {
	createPlanStoragePaths,
	createProjectStoragePaths,
} from "./storage/paths";
export {
	initializePlanFiles,
	readPlanRecord,
	readPlanRecordIfExists,
	savePlanRecord,
	updatePlanRecord,
} from "./storage/plan-store";
export {
	ensureProjectRecord,
	readProjectRecord,
	readProjectRecordIfExists,
	saveProjectRecord,
	setActivePlan,
	updateProjectRecord,
	upsertProjectPlanSummary,
} from "./storage/project-store";
export type {
	DiscoveryStep,
	DoneStep,
	ExecutionStep,
	FinalizeStep,
	InitStep,
	MergeTargets,
	PlanBranches,
	PlannerStage,
	PlannerStep,
	PlanningStep,
	PlanRecord,
	PlanStateRecord,
	PlanStatus,
	PlanSummaryStatus,
	PlanTaskSummary,
	ProjectPlanSummary,
	ProjectRecord,
	RecoveryStep,
	StepStatus,
	TaskStatus,
} from "./storage/schema";
export {
	createEmptyProjectRecord,
	createInitialPlanState,
	createPlanRecord,
	PLANNER_STAGE_STEPS,
} from "./storage/schema";
export {
	completePlanStep,
	initializePlanState,
	markPlanBroken,
	readPlanState,
	readPlanStateIfExists,
	savePlanState,
	setPlanStep,
	updatePlanState,
} from "./storage/state-store";
export type {
	CreatePlanWorktreeInput,
	CreatePlanWorktreeResult,
	RemovePlanWorktreeInput,
	RemovePlanWorktreeResult,
} from "./worktree/manager";
export {
	createPlanWorktree,
	removePlanWorktree,
} from "./worktree/manager";
export type { WorktreeLocation, WorktreeLocationKind } from "./worktree/paths";
export {
	createCustomWorktreeLocation,
	createProjectLocalWorktreeLocation,
	isProjectLocalWorktreePath,
} from "./worktree/paths";

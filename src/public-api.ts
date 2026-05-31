export { EXTENSION_NAME, SCHEMA_VERSION } from "./constants";
export {
	experimentBranchName,
	outputBranchName,
	planBranchName,
	refactorBranchName,
	taskBranchName,
} from "./git/branches";
export {
	buildGitBranchExistsArgs,
	buildGitCommitArgs,
	buildGitCreateBranchArgs,
	buildGitCurrentBranchArgs,
	buildGitDeleteBranchArgs,
	buildGitDiffNameOnlyArgs,
	buildGitDiffStatArgs,
	buildGitHeadCommitArgs,
	buildGitInitArgs,
	buildGitMergeArgs,
	buildGitStageAllArgs,
	buildGitStatusPorcelainArgs,
	buildGitSwitchBranchArgs,
	buildGitWorktreeAddArgs,
	buildGitWorktreeRemoveArgs,
	GitCommandError,
	NodeGitRunner,
} from "./git/node-runner";
export type { PlannerGitOperationResult } from "./git/planner-ops";
export {
	createAndSwitchExperimentBranch,
	createAndSwitchRefactorBranch,
	createAndSwitchTaskBranch,
	deleteManagedBranch,
	exportPlanToOutputBranch,
	mergeRefactorToTask,
	mergeSelectedExperimentToTask,
	mergeTaskToPlan,
	selectExperiment,
} from "./git/planner-ops";
export type {
	GitBranchInput,
	GitCommitInput,
	GitCreateBranchInput,
	GitDeleteBranchInput,
	GitMergeInput,
	GitRepoInput,
	GitRunner,
	GitSwitchBranchInput,
	GitWorktreeAddInput,
	GitWorktreeRemoveInput,
} from "./git/runner";
export type { GitWatcherDecision, GitWatcherState } from "./guard/git-watcher";
export {
	analyzeRawGitCommand,
	buildRawGitBlockedReason,
	checkRawGitAllowed,
	PLANNER_STATUS_TOOL_NAME,
} from "./guard/git-watcher";
export type {
	PlannerToolPolicyDecision,
	PlannerWrapperTool,
} from "./guard/tool-policy";
export {
	buildPlannerToolHint,
	checkPlannerWrapperAllowed,
	getAllowedPlannerWrapperTools,
	PLANNER_WRAPPER_TOOLS,
} from "./guard/tool-policy";
export {
	BUNDLED_INSTRUCTION_DEFAULTS_DIR,
	loadBundledInstructionDefaults,
	syncBundledInstructionFiles,
} from "./instructions/defaults";
export {
	getInstructionContent,
	getInstructionSection,
	getInstructionSectionContent,
	parseInstructionSections,
	readInstructionDefaultsFromDir,
	syncInstructionFiles,
} from "./instructions/manager";
export {
	createInstructionPaths,
	instructionFilePath,
} from "./instructions/paths";
export type {
	InstructionRouteEntry,
	InstructionRouting,
} from "./instructions/routing";
export {
	getInstructionKeysForPlannerStep,
	getInstructionRoutingForState,
} from "./instructions/routing";
export type {
	InstructionAppendSource,
	InstructionContent,
	InstructionDefaults,
	InstructionKey,
	InstructionPaths,
	InstructionSection,
	InstructionSectionName,
	SyncedInstructionFile,
} from "./instructions/schema";
export { INSTRUCTION_KEYS } from "./instructions/schema";
export type {
	MemoryGateInspection,
	MemoryGateRequiredCheck,
} from "./memory/gate";
export {
	applyMemoryGateFreshness,
	inspectMemoryGate,
	MEMORY_GATE_REQUIRED_CHECKS,
} from "./memory/gate";
export type { JsonlValidator } from "./memory/jsonl";
export {
	PlannerJsonlError,
	readJsonl,
	removeJsonlEntries,
	upsertJsonlEntries,
	writeJsonl,
} from "./memory/jsonl";
export {
	clearMemoryDirty,
	computeMemoryCheckpoint,
	initializeMemoryFiles,
	markMemoryDirty,
	readFileIndex,
	readMemoryCheckpoint,
	readMemoryDirtyState,
	readProjectPatterns,
	readRelationIndex,
	readSymbolIndex,
	removeFileEntries,
	removeRelationEntries,
	removeSymbolEntries,
	replaceFileIndex,
	replaceRelationIndex,
	replaceSymbolIndex,
	upsertFileEntries,
	upsertRelationEntries,
	upsertSymbolEntries,
	verifyMemoryCheckpoint,
	writeMemoryCheckpoint,
	writeProjectPatterns,
} from "./memory/manager";
export type { MemoryStoragePaths } from "./memory/paths";
export { createMemoryStoragePaths } from "./memory/paths";
export type {
	MemoryRetrievalCursor,
	MemoryRetrievalFilters,
	MemoryRetrievalInput,
	MemoryRetrievalLimits,
	MemoryRetrievalPage,
	MemoryRetrievalResult,
} from "./memory/retrieval";
export {
	DEFAULT_MEMORY_RETRIEVAL_LIMIT,
	MAX_MEMORY_RETRIEVAL_LIMIT,
	retrieveMemoryContext,
} from "./memory/retrieval";
export type {
	MemoryCheckpoint,
	MemoryCheckpointVerification,
	MemoryDirtyFile,
	MemoryDirtyReason,
	MemoryDirtyState,
	MemoryFileEntry,
	MemoryFileKind,
	MemoryFileStatus,
	MemoryRelationEntry,
	MemoryRelationKind,
	MemorySymbolEffects,
	MemorySymbolEntry,
	MemorySymbolGlobalState,
	MemorySymbolKind,
	MemorySymbolVisibility,
	MemoryVerificationStatus,
} from "./memory/schema";
export type {
	MemoryProjectSnapshot,
	MemoryProjectSnapshotInput,
} from "./memory/snapshot";
export { createMemoryProjectSnapshot } from "./memory/snapshot";
export type {
	MemoryFreshnessApplyInput,
	MemoryFreshnessApplyResult,
	MemoryFreshnessInput,
	MemoryFreshnessResult,
	MemoryProjectFileSnapshotEntry,
} from "./memory/verification";
export {
	analyzeMemoryFreshness,
	applyMemoryFreshness,
} from "./memory/verification";
export type {
	MemoryBatchEntryKind,
	MemoryBatchRejectedEntry,
	MemoryBatchWriteResult,
} from "./memory/write-api";
export {
	validateMemoryBatchAgainstIndexes,
	writeMemoryBatch,
	writeMemoryBatchWithReferences,
} from "./memory/write-api";
export type { GitignoreWorktreeRuleResult } from "./project-local/gitignore";
export {
	ensureProjectWorktreesIgnored,
	hasExactWorktreesIgnoreRule,
	PROJECT_WORKTREES_IGNORE_RULE,
} from "./project-local/gitignore";
export type {
	ActivePlanContext,
	ActivePlanContextReady,
	ActivePlanContextStatus,
	ActivePlanContextUnavailable,
} from "./runtime/active-plan";
export {
	readActivePlanContext,
	updateActivePlanState,
} from "./runtime/active-plan";
export type {
	PlannerCompactInstructionBundle,
	PlannerCompactInstructionSection,
	PlannerCompactRuntimeState,
} from "./runtime/compact";
export {
	buildPlannerCompactInstructionBundle,
	buildPlannerCompactInstructions,
	buildPlannerPostAutoCompactMessage,
	clearPlannerControlledCompact,
	collectAutoCompactInstructionSections,
	consumePlannerControlledCompact,
	createPlannerCompactRuntimeState,
	markPlannerControlledCompactStarted,
	PLANNER_COMPACT_MARKER,
	PLANNER_SYSTEM_INSTRUCTIONS_HEADER,
} from "./runtime/compact";
export type {
	PlannerGitReality,
	PlannerPreflightAction,
	PlannerPreflightDecision,
} from "./runtime/git-state-sync";
export {
	evaluatePlannerToolPreflight,
	inspectPlannerGitReality,
	markMemoryCheckpointSynced,
	runSyncedPlannerGitMutation,
	syncStateAfterPlannerGitMutation,
} from "./runtime/git-state-sync";
export type {
	PlannerGitToolExecutionInput,
	PlannerGitToolExecutionResult,
	PlannerGitToolName,
} from "./runtime/git-tools";
export {
	executePlannerGitTool,
	PLANNER_GIT_TOOL_NAMES,
} from "./runtime/git-tools";
export type {
	PlannerLifecycleAction,
	PlannerLifecycleDecision,
} from "./runtime/lifecycle";
export { decidePlannerLifecycleNext } from "./runtime/lifecycle";
export type {
	PlannerMemoryToolExecutionInput,
	PlannerMemoryToolExecutionResult,
	PlannerMemoryToolName,
} from "./runtime/memory-tools";
export {
	executePlannerMemoryTool,
	PLANNER_MEMORY_TOOL_NAMES,
} from "./runtime/memory-tools";
export type {
	PlannerManagedToolName,
	PlannerOrchestratorInput,
	PlannerOrchestratorNextAction,
	PlannerOrchestratorResult,
	PlannerOrchestratorToolDecision,
} from "./runtime/orchestrator";
export {
	buildPlannerOrchestrator,
	checkPlannerOrchestratorToolAllowed,
	runPlannerOrchestrator,
} from "./runtime/orchestrator";
export type {
	PlannerWrapperLifecycleGateDecision,
	PlannerWrapperLifecycleGateInput,
} from "./runtime/orchestrator-gate";
export {
	checkPlannerWrapperToolForLifecycle,
	filterPlannerWrapperToolsForLifecycle,
} from "./runtime/orchestrator-gate";
export type { PlannerCreateCommandArgs } from "./runtime/plan-naming";
export {
	parsePlannerCreateCommandArgs,
	resolvePlannerPlanId,
} from "./runtime/plan-naming";
export type {
	PlannerPlanToolExecutionInput,
	PlannerPlanToolExecutionResult,
	PlannerPlanToolName,
} from "./runtime/plan-tools";
export {
	executePlannerPlanTool,
	PLANNER_PLAN_TOOL_NAMES,
} from "./runtime/plan-tools";
export type {
	PlannerRuntimeAction,
	PlannerRuntimeDecision,
	PlannerRuntimeRealityInput,
	PlannerRuntimeRecoveryReason,
} from "./runtime/planner-runtime";
export { evaluatePlannerRuntimeReality } from "./runtime/planner-runtime";
export type {
	PlannerPreflightInput,
	PlannerPreflightResult,
	PlannerPreflightToolDecision,
} from "./runtime/preflight";
export {
	checkPlannerPreflightToolAllowed,
	formatPlannerPreflightStatus,
	runPlannerPreflight,
} from "./runtime/preflight";
export type {
	PlannerRecoveryBranchInspection,
	PlannerRecoveryInspection,
	PlannerRecoveryIssue,
	PlannerRecoveryIssueCode,
	PlannerRecoveryIssueSeverity,
} from "./runtime/recovery";
export {
	formatPlannerRecoveryInspection,
	inspectPlannerRecovery,
} from "./runtime/recovery";
export type {
	PlannerRecoveryResumeInput,
	PlannerRecoveryResumeResult,
} from "./runtime/recovery-manager";
export { resumePlannerRecovery } from "./runtime/recovery-manager";
export type {
	PlannerRecoveryToolExecutionInput,
	PlannerRecoveryToolExecutionResult,
	PlannerRecoveryToolName,
} from "./runtime/recovery-tools";
export {
	executePlannerRecoveryTool,
	PLANNER_RECOVERY_TOOL_NAMES,
} from "./runtime/recovery-tools";
export type {
	PlannerBehaviorAction,
	PlannerBehaviorArtifact,
	PlannerBehaviorGate,
	PlannerProjectAccess,
	PlannerStageBehaviorToolDecision,
	PlannerStageStepBehavior,
} from "./runtime/stage-behavior";
export {
	checkPlannerStageBehaviorWrapperTool,
	getPlannerStageStepBehavior,
	PLANNER_STAGE_BEHAVIOR,
} from "./runtime/stage-behavior";
export type {
	BlockPlannerStepOptions,
	CompletePlannerStepOptions,
	EnterPlannerRecoveryOptions,
	PlannerPosition,
	PlannerStateMachineErrorCode,
} from "./runtime/state-machine";
export {
	advancePlannerStep,
	blockPlannerStep,
	completePlannerCompact,
	completePlannerStep,
	enterPlannerRecovery,
	failPlannerStep,
	getAllowedNextPlannerPositions,
	getPlannerStepStage,
	isBeforePlannerWorktreeStep,
	isPlannerStepInStage,
	PlannerStateMachineError,
	requestPlannerCompact,
	resumePlannerAfterRecovery,
	retryPlannerStep,
	startPlannerStep,
} from "./runtime/state-machine";
export type {
	ApplyPlannerStateTransitionInput,
	PlannerStateTransition,
	PlannerStateTransitionBlockCode,
	PlannerStateTransitionResult,
	PlannerStateTransitionType,
} from "./runtime/state-transition";
export {
	applyPlannerStateTransition,
	getAllowedPlannerStateTransitionTypes,
} from "./runtime/state-transition";
export type {
	PlannerStatusTextInput,
	PlannerStepRule,
} from "./runtime/status";
export {
	buildPlannerStatusText,
	getPlannerStepRule,
	PLANNER_STATUS_INVARIANTS,
	PLANNER_STEP_RULES,
} from "./runtime/status";
export type {
	PlannerListEntry,
	PlannerUserCommandInput,
	PlannerUserCommandName,
	PlannerUserCommandResult,
} from "./runtime/user-commands";
export { executePlannerUserCommand } from "./runtime/user-commands";
export type {
	PlannerWorkflowToolExecutionInput,
	PlannerWorkflowToolExecutionResult,
	PlannerWorkflowToolName,
} from "./runtime/workflow-tools";
export {
	executePlannerWorkflowTool,
	PLANNER_WORKFLOW_TOOL_NAMES,
	workflowToolTransition,
} from "./runtime/workflow-tools";
export type { PiSessionHeader, PlannerHandoffSession } from "./session/handoff";
export {
	buildPlannerHandoffPrompt,
	buildPlannerResumePrompt,
	createPiSessionDir,
	createPlannerHandoffSession,
} from "./session/handoff";
export type { EffectivePlannerSettings } from "./settings/manager";
export {
	ensureGlobalPlannerSettings,
	loadEffectivePlannerSettings,
} from "./settings/manager";
export type { PlannerSettingsPaths } from "./settings/paths";
export { createPlannerSettingsPaths } from "./settings/paths";
export type {
	PlannerSettings,
	PlannerSettingsFile,
	WorktreeSettings,
} from "./settings/schema";
export { DEFAULT_PLANNER_SETTINGS } from "./settings/schema";
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
export { resolveProjectStoragePaths } from "./storage/project-resolver";
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
	ActivePlanBranches,
	DiscoveryStep,
	DoneStep,
	ExecutionStep,
	FinalizeStep,
	InitStep,
	MemoryUpdateReason,
	MergeTargets,
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
export type { WorktreeProjectIndexRecord } from "./storage/worktree-index";
export {
	createWorktreeProjectIndexPath,
	readWorktreeProjectIndexIfExists,
	saveWorktreeProjectIndex,
} from "./storage/worktree-index";
export type {
	CreatePlanWorktreeInput,
	CreatePlanWorktreeResult,
	RemovePlanWorktreeInput,
	RemovePlanWorktreeResult,
} from "./worktree/manager";
export { createPlanWorktree, removePlanWorktree } from "./worktree/manager";
export type { WorktreeLocation, WorktreeLocationKind } from "./worktree/paths";
export {
	createCustomWorktreeLocation,
	createProjectLocalWorktreeLocation,
	isProjectLocalWorktreePath,
} from "./worktree/paths";

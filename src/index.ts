import {
	type ExtensionAPI,
	getAgentDir,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { NodeGitRunner } from "./git/node-runner";
import {
	checkRawGitAllowed,
	PLANNER_STATUS_TOOL_NAME,
} from "./guard/git-watcher";
import {
	formatPlannerPreflightStatus,
	runPlannerPreflight,
} from "./runtime/preflight";
import {
	executePlannerWorkflowTool,
	PLANNER_WORKFLOW_TOOL_NAMES,
	type PlannerWorkflowToolName,
} from "./runtime/workflow-tools";
import { createNodeFs } from "./storage/fs";
import { createProjectStoragePaths } from "./storage/paths";
import { readProjectRecordIfExists } from "./storage/project-store";

const EMPTY_TOOL_PARAMETERS = {
	type: "object",
	properties: {},
	additionalProperties: false,
} as const;

const COMPLETE_STEP_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		nextStage: { type: "string" },
		nextStep: { type: "string" },
	},
	additionalProperties: false,
} as const;

const REASON_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		reason: { type: "string" },
	},
	required: ["reason"],
	additionalProperties: false,
} as const;

const BLOCK_STEP_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		reason: { type: "string" },
		requiresUserDecision: { type: "boolean" },
	},
	required: ["reason"],
	additionalProperties: false,
} as const;

const RESUME_RECOVERY_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		targetStage: { type: "string" },
		targetStep: { type: "string" },
	},
	required: ["targetStage", "targetStep"],
	additionalProperties: false,
} as const;

const OPTIONAL_REASON_TOOL_PARAMETERS = {
	type: "object",
	properties: {
		reason: { type: "string" },
	},
	additionalProperties: false,
} as const;

export default function piCodePlannerExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: PLANNER_STATUS_TOOL_NAME,
		label: "Planner Status",
		description:
			"Show the current pi-code-planner stage, instruction files, and allowed planner tools.",
		promptSnippet:
			"Use planner_status when a planner action is blocked or when you are unsure which planner step/tool is allowed.",
		parameters: EMPTY_TOOL_PARAMETERS as never,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const preflight = await readPlannerPreflight(ctx.cwd);
			const text = formatPlannerPreflightStatus(preflight);

			return {
				content: [{ type: "text", text }],
				details: preflight,
			};
		},
	});

	for (const toolName of PLANNER_WORKFLOW_TOOL_NAMES) {
		pi.registerTool({
			name: toolName,
			label: workflowToolLabel(toolName),
			description: workflowToolDescription(toolName),
			promptSnippet:
				"Use planner_status first, then call only the workflow transition listed as allowed for the current stage/step.",
			parameters: workflowToolParameters(toolName) as never,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = await executePlannerWorkflowTool({
					fs: createNodeFs(),
					git: new NodeGitRunner(),
					projectPaths: createProjectStoragePaths({
						agentDir: getAgentDir(),
						projectRoot: ctx.cwd,
					}),
					toolName,
					params,
				});

				return {
					content: [{ type: "text", text: result.text }],
					details: result,
				};
			},
		});
	}

	pi.on("tool_call", async (event, ctx) => {
		if (!isToolCallEventType("bash", event)) {
			return;
		}

		const state = await readActivePlannerState(ctx.cwd);
		const decision = checkRawGitAllowed({
			command: event.input.command,
			state,
		});

		if (!decision.allow) {
			return {
				block: true,
				reason:
					decision.reason ??
					"Raw git is blocked while pi-code-planner is active.",
			};
		}
	});
}

function workflowToolLabel(toolName: PlannerWorkflowToolName): string {
	switch (toolName) {
		case "planner_start_step":
			return "Planner Start Step";
		case "planner_complete_step":
			return "Planner Complete Step";
		case "planner_advance_step":
			return "Planner Advance Step";
		case "planner_fail_step":
			return "Planner Fail Step";
		case "planner_block_step":
			return "Planner Block Step";
		case "planner_retry_step":
			return "Planner Retry Step";
		case "planner_request_compact":
			return "Planner Request Compact";
		case "planner_complete_compact":
			return "Planner Complete Compact";
		case "planner_enter_recovery":
			return "Planner Enter Recovery";
		case "planner_resume_after_recovery":
			return "Planner Resume After Recovery";
	}
}

function workflowToolDescription(toolName: PlannerWorkflowToolName): string {
	switch (toolName) {
		case "planner_start_step":
			return "Start the current pending planner step after planner_status says start_step is allowed.";
		case "planner_complete_step":
			return "Mark the current running planner step as completed and store its next step.";
		case "planner_advance_step":
			return "Move from a completed planner step to its recorded next step.";
		case "planner_fail_step":
			return "Mark the current planner step as failed so the model can retry through planner_status.";
		case "planner_block_step":
			return "Mark the current planner step as blocked, optionally requiring a user decision.";
		case "planner_retry_step":
			return "Return a failed or non-user-blocked planner step to pending.";
		case "planner_request_compact":
			return "Request planner-controlled compaction for a compact step.";
		case "planner_complete_compact":
			return "Complete a planner compact gate after Pi compaction has finished.";
		case "planner_enter_recovery":
			return "Enter planner recovery when planner_status or a workflow transition requires recovery.";
		case "planner_resume_after_recovery":
			return "Resume the planner from recovery into an explicit valid stage and step.";
	}
}

function workflowToolParameters(toolName: PlannerWorkflowToolName) {
	switch (toolName) {
		case "planner_complete_step":
			return COMPLETE_STEP_TOOL_PARAMETERS;
		case "planner_fail_step":
			return REASON_TOOL_PARAMETERS;
		case "planner_block_step":
		case "planner_enter_recovery":
			return BLOCK_STEP_TOOL_PARAMETERS;
		case "planner_resume_after_recovery":
			return RESUME_RECOVERY_TOOL_PARAMETERS;
		case "planner_request_compact":
			return OPTIONAL_REASON_TOOL_PARAMETERS;
		case "planner_start_step":
		case "planner_advance_step":
		case "planner_retry_step":
		case "planner_complete_compact":
			return EMPTY_TOOL_PARAMETERS;
	}
}

async function readPlannerPreflight(projectRoot: string) {
	const fs = createNodeFs();
	const projectPaths = createProjectStoragePaths({
		agentDir: getAgentDir(),
		projectRoot,
	});
	return await runPlannerPreflight({
		fs,
		git: new NodeGitRunner(),
		projectPaths,
	});
}

async function readActivePlannerState(projectRoot: string): Promise<{
	activePlanId: string | null;
	active: boolean;
}> {
	try {
		const fs = createNodeFs();
		const paths = createProjectStoragePaths({
			agentDir: getAgentDir(),
			projectRoot,
		});
		const project = await readProjectRecordIfExists(fs, paths);
		const activePlanId = project?.activePlanId ?? null;
		return { activePlanId, active: activePlanId !== null };
	} catch {
		return { activePlanId: null, active: false };
	}
}

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
	PlannerWorkflowToolExecutionInput,
	PlannerWorkflowToolExecutionResult,
	PlannerWorkflowToolName,
} from "./runtime/workflow-tools";
export {
	executePlannerWorkflowTool,
	PLANNER_WORKFLOW_TOOL_NAMES,
	workflowToolTransition,
} from "./runtime/workflow-tools";
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
	MemoryUpdateReason,
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

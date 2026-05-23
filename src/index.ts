import {
	type ExtensionAPI,
	getAgentDir,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import {
	checkRawGitAllowed,
	PLANNER_STATUS_TOOL_NAME,
} from "./guard/git-watcher";
import { createNodeFs } from "./storage/fs";
import { createProjectStoragePaths } from "./storage/paths";
import { readProjectRecordIfExists } from "./storage/project-store";

const EMPTY_TOOL_PARAMETERS = {
	type: "object",
	properties: {},
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
			const state = await readActivePlannerState(ctx.cwd);
			const text = state.active
				? [
						"Planner status stub.",
						`Active plan: ${state.activePlanId}`,
						"",
						"Detailed stage/step routing is not implemented yet.",
						"Until planner git wrapper tools are available, do not run raw git through bash while a plan is active.",
					].join("\n")
				: [
						"Planner status stub.",
						"No active pi-code-planner plan was found for this project.",
						"Normal Pi tool behavior is allowed.",
					].join("\n");

			return {
				content: [{ type: "text", text }],
				details: state,
			};
		},
	});

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
	InstructionAppendSource,
	InstructionContent,
	InstructionDefaults,
	InstructionKey,
	InstructionPaths,
	SyncedInstructionFile,
} from "./instructions/schema";
export { INSTRUCTION_KEYS } from "./instructions/schema";
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

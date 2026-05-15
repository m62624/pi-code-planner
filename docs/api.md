# API Inventory

This document lists the current TypeScript modules and their intended use. It is
not a generated API reference. It is a human-maintained map so layers do not get
mixed accidentally.

## Extension Entry

### `src/index.ts`

Registers the Pi extension.

Responsibilities:

- create/cache `GitCore` per `cwd`
- register planner git tools
- update footer/status on `session_start`

It should stay thin. It should not manually assemble settings, fs, runtime
state, git runner, or tools.

## Settings Layer

### `src/settings/schema.ts`

Exports setting types:

- `InstructionName`
- `InstructionPathMap`
- `RefactorSettings`
- `BranchNamingSettings`
- `GitSettings`
- `PlannerSettings`
- `SettingsLoadResult`
- `PartialPlannerSettings`

### `src/settings/defaults.ts`

Exports:

- `DEFAULT_SETTINGS`

Built-in JSON settings copied into user-editable files by the initializer.

### `src/settings/default-instructions.ts`

Exports:

- `readDefaultInstructionContent(name)`

Reads bundled markdown templates from `src/instructions/defaults/*.md`. The
initializer copies these files into the user's global extension instruction
directory on first run.

### `src/settings/paths.ts`

Exports:

- `createSettingsPaths(input)`
- `resolveConfiguredPath(baseDir, path)`
- `instructionFileName(name)`

Use this module for all settings and instruction paths.

### `src/settings/fs.ts`

Exports:

- `PlannerFs`
- `createNodeFs()`
- `writeJsonFile(fs, path, value)`

`PlannerFs` allows tests to use `MemoryFs` without touching real disk.

### `src/settings/merge.ts`

Exports:

- `mergePlannerSettings(base, override)`

Settings merge is deep for known nested settings and conservative for arrays.

### `src/settings/initializer.ts`

Exports:

- `ensurePlannerFiles(paths, fs)`

Creates missing global settings and bundled instruction markdown files.

### `src/settings/loader.ts`

Exports:

- `loadPlannerSettings(paths, fs)`
- `getInstructionContent(loadResult, fs, name)`

Loads defaults, global settings, project settings, and resolves instruction
sources.

## Instruction Layer

### `src/instructions/section-parser.ts`

Exports:

- `parseMarkdownSections(markdown)`
- `getMarkdownSection(markdown, sectionName)`

Parses headings into reusable instruction sections.

### `src/instructions/manager.ts`

Exports:

- `getInstructionSectionContent(loadResult, fs, request)`

Reads a configured instruction file and returns one section, optionally appending
a `details` section.

## Artifact Layer

### `src/artifacts/planner-artifacts.ts`

Exports:

- `PlannerArtifacts`
- artifact name unions for plan, work item, and attempt artifacts
- `ArtifactReadResult`

This layer reads, writes, and appends planner-owned markdown/json artifacts under
the canonical storage paths. It does not decide workflow stages and does not
generate prompts.

Supported artifact groups:

- plan: `plan.md`, `discovery.md`, `questions.md`, `decisions.md`
- work item: `tdd_plan.md`, `tests_summary.md`, `refactor_notes.md`
- attempt: `plan.md`, `prompt.md`, `summary.md`, `score.json`,
  `verification.json`, `changed_files.json`

## Memory Layer

### `src/memory/schema.ts`

Exports language-neutral memory record types:

- `MemoryManifest`
- `FileEntry`
- `SymbolEntry`
- `SymbolRelation`
- `DirtyMemoryState`
- `MemoryIndexes`

Symbols use file paths plus `anchors.searchText` instead of line-number anchors.
The source of truth remains the project file; memory is a cached interpretation
with verification status and confidence.

### `src/memory/paths.ts`

Exports:

- `getProjectMemoryPaths(input)`
- `shardNameForFilePath(filePath)`
- `getSymbolShardPath(paths, filePath)`
- `getRelationShardPath(paths, filePath)`

Builds sharded memory paths under:

```text
getAgentDir()/extensions/pi-planner/projects/<projectKey>/memory/
```

### `src/memory/jsonl.ts`

Exports small JSONL helpers:

- `readJsonl(fs, path)`
- `writeJsonl(fs, path, entries)`
- `appendJsonl(fs, path, entries)`
- `upsertJsonlByKey(fs, path, entries, keyOf)`

### `src/memory/store.ts`

Exports:

- `ProjectMemoryStore`
- `SymbolSearchQuery`
- `SymbolContext`
- `VerifySymbolResult`

Current public methods:

- `initialize()`
- `loadManifest()`
- `upsertFiles(entries)`
- `readFiles()`
- `upsertSymbols(entries)`
- `searchSymbols(query)`
- `getSymbolsByFile(filePath)`
- `getSymbol(id)`
- `deleteSymbol(symbolId, reason)`
- `upsertRelations(entries)`
- `getRelations(symbolId)`
- `deleteRelation(relationId, reason)`
- `getSymbolContext(symbolId)`
- `markFilesDirty(filePaths, reason)`
- `clearDirtyFiles(filePaths)`
- `getDirtyFiles()`
- `verifySymbol(symbolId)`
- `verifyFile(filePath)`
- `readAllSymbols()`
- `readAllRelations()`

The first implementation is sharded JSONL with small JSON indexes. Public cycle
layers should depend on this store API, not on the storage format, so SQLite or
another embedded backend can replace it later if project size demands it.

### `src/memory/core.ts`

Exports:

- `MemoryCore`
- `createMemoryCore(options)`

Composition layer for project memory. It initializes and exposes
`ProjectMemoryStore` so entrypoint, tools, runtime, and future cycle managers
share the same memory object for a `cwd`.

### `src/memory/policy.ts`

Exports:

- `MemoryPolicyOperation`
- `MemoryPolicyDecision`
- `checkMemoryPolicy(input)`

Pure policy checker for operations that must not proceed while project memory is
dirty. Current protected operation names are `request_compact`,
`finish_work_item`, and `transition_from_signature_refresh`.

The policy is currently enforced by public compact/workflow/git tools when a
memory resolver is supplied by the entrypoint.

### `src/memory/dirty-sync.ts`

Exports:

- `SyncDirtyMemoryFromRepoInput`
- `SyncDirtyMemoryFromRepoResult`
- `syncDirtyMemoryFromRepo(input)`

Synchronizes project memory dirty files from `RepoState.status` while a planner
session is active. It collects staged, unstaged, untracked, conflicted, and
renamed paths, filters ignored prefixes from `memory.dirtyPathIgnorePrefixes`,
and calls `ProjectMemoryStore.markFilesDirty(...)`.

This module is intentionally syntactic. It does not parse source code or update
symbols. Semantic repair belongs to the later `signature_refresh` workflow
stage.

## Prompt Layer

### `src/prompts/assembler.ts`

Exports:

- `assemblePlannerPrompt(loadResult, fs, request)`
- `artifactReference(artifact, options)`

Builds a deterministic prompt from a configured markdown instruction, current
state entries, artifact paths, optional artifact content, and extra
instructions. This is the foundation for future workflow tool responses.

## Runtime State Layer

### `src/decision/engine.ts`

Exports:

- `PlannerDecisionStatus`
- `PlannerDecisionAction`
- `PlannerDecision`
- `decidePlannerNextAction(input)`

Pure read-only decision engine for the active planner lifecycle. It combines
runtime state, git recovery analysis, dirty memory, and active plan/work item
records, then returns the single next allowed action class.

Decision priority is:

1. idle runtime
2. pending compact resume
3. git/runtime recovery
4. dirty memory refresh, except while already in `signature_refresh`
5. compact boundary request
6. current plan/work-item stage

The engine does not mutate files, git, runtime state, or storage records.

## Cycle Layer

### `src/cycle/schema.ts`

Exports:

- `PlannerNextStepStatus`
- `PlannerNextStepKind`
- `PlannerRequiredTool`
- `PlannerNextStep`

Defines the normalized next-step contract returned to higher layers and the
model-facing `planner_next_step` tool.

### `src/cycle/manager.ts`

Exports:

- `PlannerCycleManager`

Read-only manager over `PlannerRuntimeController`. It converts runtime
inspection plus `PlannerDecision` into one normalized next step:

- status/kind/blocking
- required planner tool, if any
- instruction name and prompt, if available
- dirty files
- compact reason and post-compact resume purpose

It does not execute git, workflow, memory, or compact mutations.

### `src/planner-state/schema.ts`

Exports runtime state types and `DEFAULT_PLANNER_RUNTIME_STATE`.

### `src/planner-state/store.ts`

Exports parse/load/save/update/initialize helpers for `state.json`.

### `src/planner-state/runtime.ts`

Exports `RuntimeStateManager`, the cache + persistence wrapper used by git
mutations and future workflow managers.

### `src/runtime/planner-runtime-controller.ts`

Exports:

- `PlannerRuntimeController`
- `PlannerRuntimeInspection`
- `PlannerRuntimeStatus`

This is the first read-only runtime facade over active planner state. It
combines:

- persisted runtime state
- current git recovery analysis
- current memory dirty state
- planner decision
- active plan/work item records
- next prompt assembly from `PlannerOrchestrator`

The controller returns one of:

- `idle`
- `ready`
- `compact_pending`
- `compact_required`
- `memory_refresh_required`
- `recovery_required`

It does not mutate git or workflow records. Cycle managers should use the
embedded decision as the common entrypoint before deciding whether discovery,
TODO, TDD, selection, refactor, verification, compact, or recovery may proceed.

## Compaction Layer

### `src/compaction/coordinator.ts`

Exports:

- `CompactionCoordinator`
- `CompactContext`
- `ResumeMessenger`
- `RequestCompactInput`

Coordinates planner-controlled Pi compaction. It persists `pendingCompact`
before calling `ctx.compact()`, marks completion/failure from callbacks, and
keeps resume delivery separate from the compact callback.

Resume delivery rules:

- `consumeResumeInstructionForNextTurn()` returns the pending resume prompt for
  `before_agent_start` and clears `pendingCompact`.
- `sendAutoResumeIfIdle({ ctx, messenger })` sends the resume prompt as a
  delayed fallback only when Pi is idle and has no visible pending messages.
- The coordinator does not send directly from `onComplete`, so user input typed
  during compaction is not displaced by the planner resume.

## Orchestration Layer

### `src/orchestrator/planner-orchestrator.ts`

Exports:

- `PlannerOrchestrator`
- `PlannerOrchestratorBlockedByCompact`
- `createPlannerOrchestrator(core, projectPath, compactor)`

This is the first internal facade for future workflow tools. It coordinates:

- `PlanStore` for persisted project/plan/work item records
- `WorkflowManager` for legal stage transitions
- `RuntimeStateManager` for active plan/work item ids
- `CompactionCoordinator` for compact boundary handoff

Current public methods:

- `createPlan(input)`
- `readPlan(planId)`
- `transitionPlan(planId, to)`
- `createWorkItem(planId, input)`
- `readWorkItem(planId, workItemId)`
- `transitionWorkItem(planId, workItemId, to)`
- `requestDiscoveryCompact(ctx, planId, input)`
- `completeDiscoveryCompact(planId)`
- `requestWorkItemCompact(ctx, planId, input)`
- `completeWorkItemCompact(planId, workItemId)`
- `buildPlanStagePrompt(planId)`
- `buildWorkItemStagePrompt(planId, workItemId)`

Compact completion methods require the pending compact resume to be consumed
first. If `pendingCompact` is still `requested` or `completed`, they throw
`PlannerOrchestratorBlockedByCompact`.

Prompt builder methods assemble the next model instruction from settings,
planner state, and artifact references. They return `null` only when the
orchestrator was constructed without prompt dependencies, which is allowed in
low-level tests but not expected for the real extension core.

## Git Read Layer

### `src/git/runner.ts`

Exports:

- `GitRunner`
- `NodeGitRunner`

`NodeGitRunner` executes `git` via `execFile`. It is low-level and should not be
used directly by model-facing tools.

### `src/git/status-parser.ts`

Exports:

- `GitStatusSummary`
- `emptyGitStatusSummary()`
- `parsePorcelainStatus(output)`

Parses `git status --porcelain`.

### `src/git/state.ts`

Exports:

- `RepoState`
- `BranchState`
- `getRepoRoot(runner, cwd)`
- `getCurrentBranch(runner, cwd)`
- `getBranchState(runner, cwd)`
- `getCurrentCommit(runner, cwd)`
- `getRepoStatus(runner, cwd)`
- `getRepoState(runner, cwd)`

This layer reads git state only.

## Git Safety Layer

### `src/git/branch-naming.ts`

Exports:

- `renderBranchNames(settings, values)`
- `renderBranchName(settings, kind, values)`
- `validateBranchNamingSettings(settings)`

Renders and validates branch naming templates from settings.

### `src/git/policy.ts`

Exports:

- `GitPolicyOperation`
- `GitPolicyDecision`
- `checkGitPolicy(input)`

Synchronous policy checks over `RepoState` and `PlannerRuntimeState`.

### `src/git/recovery.ts`

Exports:

- `GitRecoveryStatus`
- `GitRecoveryAnalysis`
- `analyzeGitRecovery(state, repo)`

Detects divergence between runtime state and actual repository state.

### `src/git/tool-call-guard.ts`

Exports:

- `isShellToolCall(toolName, settings)`
- `analyzeGitToolCall(input)`

Analyzes shell tool calls and blocks direct git commands while a plan is active.

### `src/git/tool-call-events.ts`

Exports:

- `checkPlannerToolCall(core, event)`
- `checkPlannerUserBash(core, event)`

Adapts `analyzeGitToolCall` to Pi extension event results:

- `tool_call` returns `{ block: true, reason }`
- `user_bash` returns a handled failing `BashResult`

## Git Write Layer

### `src/git/write.ts`

Exports:

- `GitWriter`
- `RunnerGitWriter`

`RunnerGitWriter` is an internal executor. It must not be exposed directly to Pi
tools or model-facing operations.

### `src/git/mutations.ts`

Exports:

- `GitMutations`
- `GitMutationRejected`

Public mutation methods:

- `initializeRepo()`
- `createPlanBranch({ planId, startPoint })`
- `createChildBranch({ workItemId, startPoint })`
- `createExperimentBranch({ workItemId, attemptId, startPoint })`
- `selectExperimentBranch({ workItemId, attemptId })`
- `commitWorkItem({ message, stageAll })`
- `switchToPlanBranch({ planId })`
- `switchToChildBranch({ workItemId })`
- `switchToExperimentBranch({ workItemId, attemptId })`
- `mergeExperimentBranch({ workItemId, attemptId, noFastForward, message })`
- `deleteChildBranch({ workItemId, force })`
- `deleteExperimentBranch({ workItemId, attemptId, force })`
- `acceptCurrentGitState()`
- `softResetToExpected()`
- `hardResetToExpected({ confirm: true })`

Raw branch-name switch/merge/delete helpers are private by design.

### `src/git/preflight.ts`

Exports:

- `GitPreflightOperation`
- `GitPreflightResult`
- `GitPreflightService`
- `createGitPreflightService(deps)`

Preflight combines recovery analysis and git policy before a public tool calls a
mutation.

### `src/git/core.ts`

Exports:

- `GitCore`
- `createGitCore(options)`

Composition layer that wires settings, runtime state, git runner, git writer,
mutations, preflight, and repo reads.

## Pi Tools

### `src/tools/planner-compaction-tools.ts`

Exports:

- `createPlannerCompactionTools(getCompactor)`

Registered tool names:

- `planner_request_compact`

This is the public Pi tool surface for planner-controlled compaction. It calls
`CompactionCoordinator.requestCompact(...)` and never exposes raw `ctx.compact`
to higher workflow layers.

### `src/tools/planner-workflow-tools.ts`

Exports:

- `createPlannerWorkflowTools(getOrchestrator)`

Registered tool names:

- `planner_create_plan`
- `planner_transition_plan`
- `planner_create_work_item`
- `planner_transition_work_item`
- `planner_request_discovery_compact`
- `planner_complete_discovery_compact`
- `planner_request_work_item_compact`
- `planner_complete_work_item_compact`

These tools are the public Pi surface over `PlannerOrchestrator`. They are thin
wrappers: validate input, call the orchestrator, return structured details, and
convert workflow/compact-boundary rejections into tool responses.

Successful workflow tool responses return details shaped as:

```ts
{
  result: OperationResult;
  nextPrompt: AssemblePlannerPromptResult | null;
}
```

When `nextPrompt` is present, the visible tool text also includes:

```text
NEXT PLANNER INSTRUCTION
...
```

Static Pi `promptGuidelines` explain when the tools should be used, but runtime
stage instructions are delivered through the tool result so they can include the
current plan/work item state and artifact paths.

### `src/tools/planner-runtime-tools.ts`

Exports:

- `createPlannerRuntimeTools(getController)`

Registered tool names:

- `planner_runtime_status`

This tool exposes the read-only runtime controller to the model. It reports
whether planner is idle, ready, blocked by compact, or blocked by recovery. When
the controller has a next prompt, the tool text includes the same
`NEXT PLANNER INSTRUCTION` block used by workflow tools.

### `src/tools/planner-cycle-tools.ts`

Exports:

- `createPlannerCycleTools(getCycleManager)`

Registered tool names:

- `planner_next_step`

This is the preferred read-only model entrypoint before choosing the next
planner action. It returns the normalized cycle step, including `requiredTool`
when the model must handle recovery, compaction, or memory refresh before normal
implementation work.

### `src/tools/planner-memory-tools.ts`

Exports:

- `createPlannerMemoryTools(getStore)`

Registered tool names:

- `planner_memory_status`
- `planner_memory_upsert_files`
- `planner_memory_upsert_symbols`
- `planner_memory_upsert_relations`
- `planner_memory_search_symbols`
- `planner_memory_get_symbols_by_file`
- `planner_memory_get_symbol_context`
- `planner_memory_get_relations`
- `planner_memory_delete_symbol`
- `planner_memory_delete_relation`
- `planner_memory_mark_dirty`
- `planner_memory_get_dirty`
- `planner_memory_clear_dirty`
- `planner_memory_verify_symbol`
- `planner_memory_verify_file`

This is the safe public CRUD API over `ProjectMemoryStore`. The model should use
these tools during discovery and signature refresh instead of editing memory
JSONL files directly.

### `src/tools/planner-git-tools.ts`

Exports:

- `createPlannerGitTools(getCore)`

Registered tool names:

- `planner_initialize_repo`
- `planner_start_plan`
- `planner_start_work_item`
- `planner_start_experiment`
- `planner_select_experiment`
- `planner_finish_work_item`
- `planner_delete_child_branch`
- `planner_delete_experiment_branch`
- `planner_accept_current_git_state`
- `planner_soft_reset_to_expected`
- `planner_hard_reset_to_expected`

These are provider-safe names using underscores. They are the current public Pi
tool surface for git operations.

## Storage Helpers

### `src/storage/ids.ts`

Exports:

- `sanitizeId(value, fallback)`
- `shortHash(value, length)`
- `createProjectKey(projectPath)`
- `createPlanId(title, date)`
- `createWorkItemId(title)`
- `createAttemptId(index)`

Creates filesystem-safe ids for project, plan, work item, and experiment attempt
storage.

### `src/storage/paths.ts`

Exports:

- `getProjectsRoot(paths)`
- `getProjectStoragePaths(input)`
- `getPlanStoragePaths(input)`
- `getWorkItemStoragePaths(input)`
- `getAttemptStoragePaths(input)`

Builds canonical storage paths under:

```text
getAgentDir()/extensions/pi-planner/projects/<projectKey>/
```

Plans are grouped by project. Project-local `.pi/extensions/pi-planner` remains
reserved for settings and instruction overrides by default.

### `src/storage/schema.ts`

Exports:

- `ProjectRecord`
- `PlanRecord`
- `WorkItemRecord`
- `ExperimentAttemptRecord`
- status unions for plan, work item, and attempt records

These are the JSON records persisted by the storage skeleton. Plan, work item,
and attempt records store both `stage` and `status`:

- `stage` is the precise workflow position.
- `status` is the coarse UI/storage status derived by the workflow layer.

### `src/storage/store.ts`

Exports:

- `PlanStore`
- `parseProjectRecord(value)`
- `parsePlanRecord(value)`
- `parseWorkItemRecord(value)`
- `parseExperimentAttemptRecord(value)`

`PlanStore` currently supports:

- `ensureProject(projectPath)`
- `readProject(projectPath)`
- `createPlan(projectPath, input)`
- `readPlan(projectPath, planId)`
- `updatePlan(projectPath, planId, input)`
- `createWorkItem(projectPath, planId, input)`
- `readWorkItem(projectPath, planId, workItemId)`
- `updateWorkItem(projectPath, planId, workItemId, input)`
- `createAttempt(projectPath, planId, workItemId, input)`
- `readAttempt(projectPath, planId, workItemId, attemptId)`
- `updateAttempt(projectPath, planId, workItemId, attemptId, input)`

The store creates JSON records and placeholder markdown/json artifacts under the
canonical storage paths. Listing APIs are intentionally not present yet because
the generic `PlannerFs` interface does not expose directory reads.

Storage update methods are low-level persistence helpers. Public workflow tools
should prefer `WorkflowManager` so stage and status stay synchronized.

## Test Utilities

### `src/test/memory-fs.ts`

Exports:

- `MemoryFs`

In-memory implementation of `PlannerFs` for tests.

## Workflow

### `src/workflow/schema.ts`

Exports:

- `PLAN_STAGES`
- `PlanStage`
- `WORK_ITEM_STAGES`
- `WorkItemStage`
- `ATTEMPT_STAGES`
- `AttemptStage`
- `WorkflowTransitionDecision`

These stages model the target planner lifecycle from [Workflow](workflow.md).

### `src/workflow/transitions.ts`

Exports:

- `canTransitionPlan(from, to)`
- `canTransitionWorkItem(from, to)`
- `canTransitionAttempt(from, to)`

These pure validators decide whether a requested stage transition is allowed.
They do not mutate storage. Future workflow managers/tools should call these
before updating `plan.json`, `work_item.json`, or `attempt.json`.

Work item transitions include explicit `work_item_commit`, `signature_refresh`,
and `work_item_compact_required` stages so a completed item cannot skip the
planner-controlled commit, memory refresh, and compact boundary.

### `src/workflow/status.ts`

Exports:

- `derivePlanStatus(stage)`
- `deriveWorkItemStatus(stage)`
- `deriveAttemptStatus(stage)`

Maps precise workflow stages to coarse storage/UI statuses. This keeps
`plan.json`, `work_item.json`, and `attempt.json` readable without losing exact
stage information.

### `src/workflow/manager.ts`

Exports:

- `WorkflowManager`
- `WorkflowTransitionRejected`
- `WorkflowTransitionResult`

`WorkflowManager` is the first mutation layer for planner lifecycle state. It
loads the previous storage record, validates the transition with
`src/workflow/transitions.ts`, derives the matching coarse status, writes the
updated record through `PlanStore`, and returns `{ previous, current, decision }`.

Public layer/tools should use:

- `transitionPlan(projectPath, planId, to)`
- `transitionWorkItem(projectPath, planId, workItemId, to)`
- `transitionAttempt(projectPath, planId, workItemId, attemptId, to)`

Invalid transitions throw `WorkflowTransitionRejected` and leave storage
unchanged.

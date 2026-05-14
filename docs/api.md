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

- `DEFAULT_INSTRUCTION_CONTENT`
- `DEFAULT_SETTINGS`

Built-in defaults are copied into user-editable files by the initializer.

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

## Runtime State Layer

### `src/planner-state/schema.ts`

Exports runtime state types and `DEFAULT_PLANNER_RUNTIME_STATE`.

### `src/planner-state/store.ts`

Exports parse/load/save/update/initialize helpers for `state.json`.

### `src/planner-state/runtime.ts`

Exports `RuntimeStateManager`, the cache + persistence wrapper used by git
mutations and future workflow managers.

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

## Test Utilities

### `src/test/memory-fs.ts`

Exports:

- `MemoryFs`

In-memory implementation of `PlannerFs` for tests.

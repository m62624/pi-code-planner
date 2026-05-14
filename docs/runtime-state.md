# Runtime State

Runtime state is stored separately from settings. Settings describe user
preferences. Runtime state describes the active planner session, expected git
position, pending operation, and managed branch registry.

## Location

```text
getAgentDir()/extensions/pi-planner/state.json
```

The state manager keeps an in-memory copy and writes every mutation back to disk.
After restart, the extension can reload `state.json` and decide whether normal
work can continue or recovery is required.

## Modes

Current runtime modes:

- `idle`
  - No active planner plan.
  - Pi should behave normally.

- `plan_active`
  - A planner plan is active.
  - Git guardrails, preflight checks, and planner branch tracking are enabled.

- `operation_in_progress`
  - A git mutation has started and persisted a `pendingOperation`.
  - Used for crash recovery.

- `recovery_required`
  - Reserved mode for blocked runtime recovery.

The future workflow stages in [Workflow](workflow.md) are more detailed than
these runtime modes. Runtime modes are low-level extension safety states.

## State Shape

```ts
interface PlannerRuntimeState {
  version: 1;
  mode: PlannerRuntimeMode;
  activePlanId: string | null;
  activeWorkItemId: string | null;
  git: PlannerGitState;
  pendingOperation: PendingPlannerGitOperation | null;
  branches: PlannerBranchRegistry;
}
```

## Git Position

```ts
interface PlannerGitState {
  baseBranch: string | null;
  planBranch: string | null;
  expectedBranch: string | null;
  expectedCommit: string | null;
  lastObservedCommit: string | null;
}
```

`expectedBranch` and `expectedCommit` are checked before planner-controlled git
operations. If the real repository moved without the planner, recovery analysis
reports the mismatch.

## Pending Operation

```ts
interface PendingPlannerGitOperation {
  id: string;
  type:
    | "init"
    | "create_branch"
    | "switch_branch"
    | "commit"
    | "merge"
    | "delete_branch"
    | "soft_reset"
    | "hard_reset";
  startedAt: string;
  before: PlannerGitPosition;
  expectedAfter: PlannerGitPosition | null;
}
```

Mutations write `pendingOperation` before executing git, then clear it after
rereading repository state and saving the new expected branch/commit. If the
process dies mid-operation, recovery can detect the pending operation.

## Branch Registry

```ts
interface PlannerBranchRecord {
  name: string;
  kind: "base" | "plan" | "child" | "experiment";
  planId: string | null;
  workItemId: string | null;
  createdFromCommit: string | null;
  lastKnownCommit: string | null;
  status:
    | "active"
    | "merged"
    | "abandoned"
    | "selected"
    | "rejected"
    | "deleted";
}
```

The registry is used to distinguish planner-managed branches from unknown user
branches. Plan and base branches are protected from automatic deletion.

## RuntimeStateManager API

Source: `src/planner-state/runtime.ts`

- `initialize()`
  - Creates missing `state.json` with the default state.
  - Loads state into RAM.

- `load()`
  - Reads `state.json` from disk and updates the RAM cache.

- `get()`
  - Returns cached state if available.
  - Loads from disk if needed.

- `refresh()`
  - Forces a disk read and cache update.

- `replace(state)`
  - Atomically writes state and replaces the RAM cache.

- `update(mutator)`
  - Reads current cached state, applies a mutator, persists the result.

- `isActive()`
  - Returns true when a plan or operation is active.

- `sleep()`
  - Returns runtime to idle and clears active ids/pending operation.

## Store API

Source: `src/planner-state/store.ts`

- `parsePlannerRuntimeState(value)`
- `loadPlannerRuntimeState(paths, fs)`
- `savePlannerRuntimeState(paths, fs, state)`
- `updatePlannerRuntimeState(paths, fs, mutator)`
- `initializePlannerRuntimeState(paths, fs)`

The store validates persisted JSON before returning it.


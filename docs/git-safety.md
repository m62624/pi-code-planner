# Git Safety

Git safety is the foundation for every higher-level planner workflow. While a
plan is active, direct git writes must go through planner-controlled layers so
runtime state, expected branch/commit, and recovery metadata stay synchronized.

## Layers

Current git layers:

1. Read layer
   - `GitRunner`
   - `getRepoState`
   - `parsePorcelainStatus`

2. Safety layer
   - branch naming validation
   - policy decisions
   - recovery analysis
   - direct tool-call guard analysis

3. Write layer
   - internal `RunnerGitWriter`
   - public `GitMutations`

4. Public composition/tool layer
   - `GitCore`
   - preflight service
   - Pi tools in `src/tools/planner-git-tools.ts`

See [API Inventory](api.md#git-read-layer) for exact TypeScript APIs.

## Public API Boundary

`RunnerGitWriter` is an internal executor only. It must not be exposed directly
to Pi tools, model-facing commands, or planner flows.

Public planner operations must use `GitMutations` or a higher-level
tool/recovery/workflow layer. That layer is responsible for:

- policy checks
- `pendingOperation`
- rereading repository state after writes
- updating `state.json`
- updating expected branch/commit

Raw branch-name switch/merge/delete helpers are private inside `GitMutations`.
Public methods should use ids such as `planId`, `workItemId`, and `attemptId`.

## Read State

`RepoState` captures the current repository view:

```ts
interface RepoState {
  cwd: string;
  repoRoot: string | null;
  isRepo: boolean;
  currentBranch: string | null;
  currentCommit: string | null;
  isDetachedHead: boolean;
  status: GitStatusSummary;
}
```

`GitStatusSummary` tracks:

- staged files
- unstaged files
- untracked files
- conflicted files
- dirty/conflict booleans

## Policy Checks

`checkGitPolicy` currently covers:

- `start_plan`
- `start_work_item`
- `finish_work_item`
- `switch_branch`
- `delete_branch`
- `merge_branch`
- `delete_plan`
- `recover_external_change`

Policy can return:

- `allow`
- `block`
- `recovery_required`

Typical blockers:

- repository missing
- no active plan
- detached HEAD
- wrong branch
- unexpected commit
- dirty worktree
- conflicts
- no changes
- protected branch
- unknown branch

## Recovery Analysis

`analyzeGitRecovery(state, repo)` compares runtime state with real git state.

Statuses:

- `ok`
- `inactive`
- `init_required`
- `pending_operation`
- `detached_head`
- `conflicts`
- `dirty_worktree`
- `external_branch_change`
- `external_commit_change`
- `registered_experiment_branch`
- `registered_child_branch`
- `unknown_branch`

Normal planner operations should block when recovery is required, except for
explicit recovery tools and carefully scoped operations such as finishing a work
item with expected dirty changes.

## Preflight

`GitPreflightService` combines recovery analysis and policy checks before tools
call mutations.

Supported preflight operations:

- `initialize_repo`
- `start_plan`
- `start_work_item`
- `finish_work_item`
- `switch_branch`
- `merge_branch`
- `delete_branch`
- `recovery`

Public tools should call preflight first, then call a mutation only when
preflight allows it.

## Mutations

`GitMutations` is the current public write API. It persists `pendingOperation`
before git writes and clears it only after rereading repo state.

Implemented operations:

- initialize repo
- create plan branch
- create child branch
- create experiment branch
- select experiment branch
- commit work item
- switch to managed branches
- merge experiment branch
- delete child/experiment branch
- accept current git state
- soft reset to expected
- hard reset to expected with explicit confirmation

## Dangerous Operations

These operations must stay behind policy, runtime state, and `pendingOperation`:

- hard reset
- soft reset
- force delete branch
- merge
- branch switch while a plan is active
- commit while a plan is active

`hardResetToExpected` requires explicit confirmation. Raw `hardReset` on
`RunnerGitWriter` is not public API.

## Direct Tool-Call Guard

`analyzeGitToolCall` checks shell-like tool calls while a plan is active.

It blocks commands matching:

- `git.blockedCommitPatterns`
- `git.blockedDangerousPatterns`

The guard is connected to Pi events:

- `tool_call`
  - returns `{ block: true, reason }` for model tool calls that attempt direct
    managed git writes through shell tools.

- `user_bash`
  - Pi does not expose a block flag for this event.
  - The extension returns a handled failing `BashResult` with exit code `1`.

Read-only git commands such as `git status --short` are allowed. Non-shell tools
that contain git text in their content are ignored.

## Branch Naming

Git branch names are refs. A branch named `planner/plan` prevents creating
another branch named `planner/plan/work/parser`, because Git cannot use the same
ref path as both a file and a directory.

Use a namespace layout where the main plan branch is a leaf under the plan
namespace:

```text
planner/<plan-id>/main
planner/<plan-id>/work/<work-item-id>
planner/<plan-id>/experiment/<work-item-id>/<attempt-id>
```

The default machine-readable setting is:

```json
{
  "git": {
    "branchNaming": {
      "plan": "planner/{planId}/main",
      "child": "planner/{planId}/work/{workItemId}",
      "experiment": "planner/{planId}/experiment/{workItemId}/{attemptId}"
    }
  }
}
```

Supported placeholders:

- `{planId}`
- `{workItemId}`
- `{attemptId}`

Required placeholders:

- `plan` requires `{planId}`
- `child` requires `{planId}` and `{workItemId}`
- `experiment` requires `{planId}`, `{workItemId}`, and `{attemptId}`

Branch naming templates are settings, not markdown instructions. They are parsed
and validated by code because they affect git safety.

## Planner Git Tools

Current public Pi tools:

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

These are low-level git tools. Future planner tools should sit above them and
model plan/work item workflow concepts directly.

## Real Git Integration Tests

Real git integration tests must run only inside OS temp directories created via
Node's cross-platform temp APIs:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = mkdtempSync(join(tmpdir(), "pi-planner-"));

try {
  // run git commands only inside repo
} finally {
  rmSync(repo, { recursive: true, force: true });
}
```

Integration tests must not run destructive git commands in the project checkout.

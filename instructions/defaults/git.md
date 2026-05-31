# git

## Purpose

Use git as the planner consistency layer without allowing the model to manipulate branches or commits directly. While a planner plan is active, raw git through shell is forbidden, including read-only raw git commands.

## Public Planner Git Wrappers

- `planner_git_inspect` reads controlled branch, HEAD, dirty state, conflicts, and related git reality.
- `planner_git_init` initializes git only during controlled init.
- `planner_git_commit` stages and commits the current atomic checkpoint.
- `planner_git_create_task_branch` creates or switches the active task branch.
- `planner_git_create_experiment_branch` creates or switches one attempt branch.
- `planner_git_select_experiment` records the chosen attempt id.
- `planner_git_merge_selected_experiment` merges state-selected experiment into current task.
- `planner_git_create_refactor_branch` creates the refactor branch when required.
- `planner_git_merge_refactor_to_task` merges refactor result into current task.
- `planner_git_merge_task_to_plan` merges current task into protected plan branch.
- `planner_git_export_plan_to_output` exports accepted result to output branch.
- `planner_git_remove_plan_worktree` removes the temporary plan worktree after acceptance.
- `planner_git_cleanup_managed_branches` removes safe-to-delete managed child branches.

## Branch Lifecycle

```text
base branch
  -> plan/<plan-id>
    -> task/<plan-id>/<task-id>
      -> experiment/<plan-id>/<task-id>/<attempt-id>
      -> refactor/<plan-id>/<task-id>
  -> output/<plan-id>
```

The extension stores branch registry and merge targets in `state.json`. The model chooses ids only. It never chooses merge source or target branch names manually.

## Checkpoint Rules

- Commit only through `planner_git_commit`.
- After commit or merge, normal flow is blocked until affected memory is updated, verified, and checkpointed.
- A dirty worktree is allowed during implementation but not at memory checkpoint sync or compact boundaries.
- Conflicts, unexpected branch changes, missing worktrees, and inconsistent history require recovery inspection.
- External commits trigger memory refresh, not automatic reset.

## Cleanup Rules

- Unselected experiment branches are deleted after selected experiment merge.
- Selected experiment branch is deleted after merge into task.
- Refactor branch is deleted after merge into task.
- Task branch is deleted after merge into plan.
- Plan branch is protected from managed child cleanup.
- Worktree removal and final export happen only after explicit user acceptance.

## Restrictions

- Do not run `git` through shell.
- Do not use shell aliases, scripts, or indirect commands to bypass planner git wrappers.
- Do not reset, force checkout, abort, delete, or discard changes without explicit user approval through recovery flow.

## manual-compact

Preserve current branch, HEAD, last checkpoint commit, dirty/conflict status, managed branch registry, merge targets, selected experiment, cleanup obligations, and exact next wrapper. After compaction, call `planner_status`.

## auto-compact

Call `planner_status` immediately. Inspect git through planner wrappers before resuming. Do not infer current branch or commit from compacted chat history.

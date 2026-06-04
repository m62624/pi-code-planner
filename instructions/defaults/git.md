# git

## Purpose

Use git as the planner consistency layer without allowing the model to manipulate branches or commits directly. While a planner plan is active, raw git through shell is forbidden, including read-only raw git commands.

## Public Planner Git Wrappers

- `planner_git_inspect` reads controlled branch, HEAD, dirty state, conflicts, and related git reality.
- `planner_git_init` initializes git only during controlled init.
- `planner_git_commit` stages and commits the current atomic checkpoint.
- `planner_git_create_task_branch` creates or switches the active task branch.
- `planner_git_create_refactor_branch` creates the refactor branch when required.
- `planner_git_merge_refactor_to_task` merges refactor result into current task.
- `planner_git_merge_task_to_plan` merges current task into protected plan branch.

Final export, worktree removal, temporary branch cleanup, planner artifact removal, and Pi JSONL session handoff are intentionally not model tools. After explicit user acceptance, ask the user to run `/planner-finish`.

## Branch Lifecycle

```text
base branch
  -> plan/<plan-id>
    -> task/<plan-id>/<task-id>
      -> refactor/<plan-id>/<task-id>
  -> output/<plan-id>
```

The extension stores branch registry and merge targets in `state.json`. The model chooses ids only. It never chooses merge source or target branch names manually.

## Worktree Command Invariant

While a planner plan is active, the persisted worktree path reported by `planner_status` is the only project working directory.

- Run every project-scoped shell command from the reported worktree path, regardless of language, package manager, build system, or script runner.
- This includes tests, builds, type checks, linters, formatters, code generators, dependency inspection, package scripts, compiler commands, and project-specific verification commands.
- Examples such as `npm test`, `cargo test`, `go test ./...`, `mvn test`, `make`, or custom scripts are only examples. The invariant applies to every project command.
- Never run project checks from the original checkout while a planner plan is active.
- If the current shell cwd is unclear, call `planner_status`, read the exact worktree path, and execute the command with that path as cwd.
- Planner artifact reads and writes still use the artifact paths reported by `planner_status`.

## Checkpoint Rules

- Commit only through `planner_git_commit`.
- After commit or merge, call `planner_status` and continue the persisted state-machine step.
- A dirty worktree is allowed during implementation but must be resolved before merge boundaries.
- Conflicts, unexpected branch changes, missing worktrees, and inconsistent history require recovery inspection.
- External commits trigger recovery inspection, not automatic reset.

## Cleanup Rules

- Refactor branch is deleted after merge into task.
- Task branch is deleted after merge into plan.
- Plan branch is protected from managed child cleanup.
- Worktree removal and final export happen only after explicit user acceptance.

## Restrictions

- Do not run `git` through shell.
- Do not use shell aliases, scripts, or indirect commands to bypass planner git wrappers.
- Built-in project write/edit calls are enabled only for the exact execution steps reported by `planner_status`: `write_tests`, `implement_task`, and `refactor_task`. The planner does not infer file roles from names.
- Never edit the original checkout while a planner worktree is active. All project changes belong in the persisted worktree path.
- Do not reset, force checkout, abort, delete, or discard changes without explicit user approval through recovery flow.

## manual-compact

Preserve current branch, HEAD, dirty/conflict status, managed branch registry, merge targets, cleanup obligations, and exact next wrapper. After compaction, call `planner_status`.

## auto-compact

Call `planner_status` immediately. Inspect git through planner wrappers before resuming. Do not infer current branch or commit from compacted chat history.

## Git Integration Diagnostics

### 1. Git Wrappers vs. Raw Git
- **Never use Raw Git**: Raw git commands run via bash bypass the state machine and corrupt the planner state. Only use planner git wrapper tools.
- **Branch Name Conflicts**: Ensure branch names follow the expected project structure.
- **Worktree State Incoherence**: If the git worktree state disagrees with the planner database, run recovery tools immediately.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

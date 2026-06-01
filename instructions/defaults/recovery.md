# recovery

## Purpose

Recover safely after crash, manual git changes, missing worktree, wrong branch, conflicts, stale memory, corrupted checkpoint, or inconsistent planner storage.

Recovery is inspection-first. It must never perform destructive repair without explicit user approval.

## Strict Step Order

1. `read_state`
   - Read `project.json`, active `plan.json`, and active `state.json`.
2. `inspect_git`
   - Use planner inspection wrappers to read worktree path, branch, HEAD, dirty state, conflicts, and managed branch existence.
3. `compare_expected_actual`
   - Compare actual git and memory reality with persisted branch, worktree, merge targets, and checkpoint commit.
4. `classify_recovery`
   - Classify missing worktree, wrong branch, dirty checkpoint boundary, external commit, manual checkout, history rewrite, conflict, missing files, or checkpoint corruption.
5. `ask_user_if_destructive`
   - Ask the user before reset, delete, force checkout, abort, discard, or other destructive repair.
6. `repair_or_resume`
   - Apply only approved repair or resume into an explicit valid non-recovery stage and step.

## Recovery Rules

- Use `planner_recovery_inspect` before proposing action.
- Until recovery confirms the persisted worktree path, do not run project tests, builds, generators, or verification commands. After resume, run them only from the worktree path reported by `planner_status`.
- Do not run raw git.
- Do not hide external changes.
- A stale memory blob is not a reason to reset git. Refresh memory instead.
- A clean external commit is not automatically an error. Mark memory stale, update affected entries, sync checkpoint, then resume.
- Conflicts, missing worktrees, missing state, and corrupted checkpoints block normal flow.
- If the original project directory is missing, tell the user clearly and use only documented best-effort cleanup paths.
- Persisted state and planner git wrappers remain the source of branch and merge targets.

## Resume Reload

After recovery resume:

1. Call `planner_status`.
2. Read the exact stage instruction bundle.
3. Reread full `plan.md` when scope, task ordering, branch history, or user feedback may have changed.
4. Reload active `task.md`, `tdd.md`, summaries, and bounded memory when resuming execution.
5. Continue only after git and memory gates are clear.

## auto-compact

Call `planner_status` immediately. Do not assume recovery was completed. Reload persisted state, rerun recovery inspection, and wait for explicit user approval before destructive repair.

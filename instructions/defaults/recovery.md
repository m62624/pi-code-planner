# recovery

## Purpose

Recover safely after crash, manual git changes, missing worktree, wrong branch, conflicts, or inconsistent planner storage.

Recovery is inspection-first. It must never perform destructive repair without explicit user approval.

## Strict Step Order

1. `read_state`
   - Read `project.json`, active `plan.json`, and active `state.json`.
2. `inspect_git`
   - Use planner inspection wrappers to read worktree path, branch, HEAD, dirty state, conflicts, and managed branch existence.
3. `compare_expected_actual`
   - Compare actual git reality with persisted branch, worktree, and merge targets.
4. `classify_recovery`
   - Classify missing worktree, wrong branch, dirty worktree, external commit, manual checkout, history rewrite, conflict, or missing files.
5. `ask_user_if_destructive`
   - Ask the user before reset, delete, force checkout, abort, discard, or other destructive repair.
6. `repair_or_resume`
   - Apply only approved repair or resume into an explicit valid non-recovery stage and step.

## Recovery Rules

- Use `planner_recovery_inspect` before proposing action.
- Until recovery confirms the persisted worktree path, do not run project tests, builds, generators, or verification commands. After resume, run them only from the worktree path reported by `planner_status`.
- Do not run raw git.
- Do not hide external changes.
- Missing project context is not a reason to reset git. Rebuild a bounded overview when needed.
- A clean external commit is not automatically an error. Inspect the actual branch and resume only when persisted state is coherent.
- Conflicts, missing worktrees, and missing state block normal flow.
- If the original project directory is missing, tell the user clearly and use only documented best-effort cleanup paths.
- Persisted state and planner git wrappers remain the source of branch and merge targets.

## Resume Reload

After recovery resume:

1. Call `planner_status`.
2. Read the exact stage instruction bundle.
3. Reread full `plan.md` when scope, task ordering, branch history, or user feedback may have changed.
4. Reload active `task.md`, `tdd.md`, summaries, and focused source files only when needed after resuming execution.
5. Continue only after the git recovery gate is clear.

## auto-compact

Call `planner_status` immediately. Do not assume recovery was completed. Reload persisted state, rerun recovery inspection, and wait for explicit user approval before destructive repair.

## Recovery & Git-State Diagnostics

### 1. Recovery Gating
- **No Progress during Recovery**: You are blocked from running normal planner commands while in recovery. You must resolve the git discrepancy first.
- **Identify Root Cause**: Read the recovery inspection report. Determine if the issue is a missing worktree, a manually checked out branch, or corrupted JSON files.
- **User Approval for Destructive Acts**: Never run reset or delete actions without asking the user.

### 2. Resolution Flow
1. Inspect git state with `planner_recovery_inspect`.
2. Follow the recovery classification suggestions.
3. Resume to a safe stage/step via `planner_recovery_resume`.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

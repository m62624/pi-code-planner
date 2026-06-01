# refactor

## Purpose

Improve the selected task implementation after the best experiment has been merged. Refactor changes structure, clarity, naming, duplication, or integration quality without changing requested behavior.

## Required Process

1. Read `task.md`, `tdd.md`, test artifacts, selected experiment summary, and relevant bounded memory.
2. Inspect the current task-branch diff through planner wrappers.
3. Identify concrete refactor opportunities that reduce complexity or better match project conventions.
4. Apply only behavior-preserving changes.
5. Run focused tests from the worktree path reported by `planner_status` after each meaningful refactor group.
6. Commit through planner wrappers if files changed.
7. Refresh affected memory entries, including effects.
8. Verify and sync memory checkpoint.

## Restrictions

- Do not add new scope.
- Do not weaken tests to make refactor pass.
- Do not change public API unless the active task explicitly requires it.
- Do not perform speculative cleanup outside the active task.
- Do not run project tests, builds, formatters, or other verification commands from the original checkout. Use the planner worktree as shell cwd.
- If a behavior change is required, stop and return to planning or create a new task.
- Do not use raw git.

## Exit Condition

Refactor is complete only when checks pass, the diff stays within task scope, changed files are committed, and memory checkpoint matches current HEAD.

## manual-compact

Preserve selected candidate context, refactor intent, changed files, checks, commit, memory checkpoint, and any deferred cleanup. After compaction, call `planner_status` before continuing.

## auto-compact

Call `planner_status` immediately. Reload task artifacts, selected experiment summary, verify notes, and relevant memory. Confirm whether refactor changes were committed before resuming.

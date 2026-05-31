# execution

## Purpose

Execute exactly one active task at a time through tests-first development, sequential experiments, candidate selection, refactor, verification, merge, memory sync, and task compact.

## Context Reload Policy

- At `prepare_task`, call `planner_status`, reread the full `plan.md`, read the selected `task.md`, then inspect relevant bounded memory.
- During one experiment loop, reread `task.md`, `tdd.md`, test/verify artifacts, completed experiment summaries, and relevant memory. Read the full `plan.md` only when integration context is unclear.
- After `compact_task`, do not carry live reasoning into the next task. Call `planner_status`, reread the full `plan.md`, inspect task status, then load the next `task.md`.
- After recovery or auto-compact, call `planner_status` before any edit or check.

## Strict Task Lifecycle

1. `prepare_task`
   - Select exactly one pending task.
   - Create or switch its task branch with planner git wrappers.
2. `write_tdd_plan`
   - Read task context and write `tdd.md`.
   - Define test strategy, mocks, fixtures, checks, edge cases, and expected failing signal.
3. `write_tests`
   - Write failing, mock, or contract tests before production implementation.
4. `run_failing_tests`
   - Run focused checks and prove that tests detect the missing behavior.
5. `start_experiments`
   - Create one experiment branch for one distinct implementation attempt.
6. `run_experiment`
   - Implement only the active attempt.
   - Run checks, commit through planner git, refresh memory, verify it, and sync checkpoint.
7. `summarize_experiment`
   - Record approach, checks, diff summary, strengths, weaknesses, risks, and numeric comparison evidence.
8. `compact_experiment`
   - Compact the completed attempt.
9. `select_experiment`
   - Decide whether another genuinely different attempt is required.
   - If yes, continue to `start_experiments`.
   - If the attempt budget or stop criteria are satisfied, select the best attempt id and continue to merge.
10. `merge_best_experiment`
   - Use the planner wrapper. Source and target branches come from persisted state.
   - Refresh and sync memory after merge.
11. `refactor_task`
   - Improve the selected result without changing behavior.
   - Commit and refresh memory only if files changed.
12. `run_final_tests`
   - Run final focused and integration checks. Inspect scope and accidental edits.
13. `merge_task_to_plan`
   - Merge the task branch into the plan branch through the planner wrapper.
   - Refresh and sync memory after merge.
14. `compact_task`
   - Compact the completed task result.
15. `select_next_task`
   - Choose `execution/prepare_task` for the next task or `finalize/verify_plan_branch` when execution is complete.

## Atomic Unit Rules

- A commit alone does not finish an atomic unit.
- After every planner-controlled commit or merge, memory must be refreshed, verified, and checkpointed before normal flow continues.
- Dirty worktree is allowed while implementing a running step, but checkpoint sync requires a clean worktree.
- Use `planner_status` after every wrapper result.
- Raw git is forbidden.
- The model chooses task id and experiment id only. It never invents merge source or target branches.

## Scope Rules

- Test writing must happen before production behavior changes.
- Experiment branches are for alternative implementations, not refactor polish.
- Refactor happens only after the best experiment is merged into the task branch.
- Do not modify unrelated files. Before finishing a task, inspect the planner-controlled diff and verify scope.
- If new required work exceeds the current task, record it as a new task or return to planning.

## manual-compact

Preserve the plan id, active task id, active experiment id, exact branch, checkpoint commit, current step, task artifact paths, verification results, selected candidate state, completed experiment summaries, open risks, and exact next action. After compaction, call `planner_status`.

For `compact_experiment`, reload `task.md`, `tdd.md`, tests, verify notes, prior experiment summaries, and relevant memory. For `compact_task`, reload full `plan.md` before choosing the next task.

## auto-compact

Call `planner_status` immediately. Do not continue editing from chat memory. Restore the exact task and experiment from persisted state, inspect git and memory gates, then reread the artifacts required by the current step. If scope may have changed, reread full `plan.md`.

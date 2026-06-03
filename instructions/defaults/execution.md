# execution

## Purpose

Execute exactly one active task at a time through tests-first development, sequential experiments, candidate selection, refactor, verification, merge, and task compact.

## Context Reload Policy

- At `prepare_task`, call `planner_status`, reread the full `plan.md`, read answered `questions.md` and `decisions.md`, read the selected `task.md`, then inspect `discovery.md` and use focused project search only if needed.
- During one experiment loop, reread `task.md`, `tdd.md`, test/verify artifacts, and completed experiment summaries. Read the full `plan.md` only when integration context is unclear.
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
   - Record `tests.md`. If project files changed, commit through planner git before experiments.
4. `run_failing_tests`
   - Run focused checks and prove that tests detect the missing behavior.
5. `start_experiments`
   - Create one experiment branch for one distinct implementation attempt.
6. `run_experiment`
   - Implement only the active attempt.
   - Run checks and commit through planner git.
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
   - Call `planner_status` after merge.
11. `refactor_task`
   - Challenge the selected result without changing behavior.
   - Write `refactor.md` with a concrete KISS review. Passing checks alone do not prove that refactor review is complete.
   - Commit only if files changed.
12. `run_final_tests`
   - Run final focused and integration checks. Inspect scope and accidental edits.
13. `merge_task_to_plan`
   - Merge the task branch into the plan branch through the planner wrapper.
   - Call `planner_status` after merge.
14. `compact_task`
   - Compact the completed task result.
15. `select_next_task`
   - Choose `execution/prepare_task` for the next task or `finalize/verify_plan_branch` when execution is complete.

## Atomic Unit Rules

- A commit alone does not finish an atomic unit.
- After every planner-controlled commit or merge, call `planner_status` and continue the persisted state-machine step.
- Dirty worktree is allowed while implementing a running step, but must be resolved before merge boundaries.
- Built-in project write/edit calls are enabled only during `write_tests`, `run_experiment`, and `refactor_task`. The planner does not infer file roles from names, so tests, fixtures, harness wiring, configuration, and production code may share files. Follow the exact step purpose.
- Never edit the original checkout while a planner worktree is active. Continue inside the worktree session reported by `planner_status`.
- Run every project command from the worktree path reported by `planner_status`. This includes focused tests, full tests, builds, type checks, linters, formatters, generators, package scripts, compilers, and project-specific verification commands, regardless of language or tooling.
- Before recording a successful check, confirm that its shell cwd was the planner worktree, not the original checkout.
- Use `planner_status` after every wrapper result.
- Raw git is forbidden.
- The model chooses task id and experiment id only. It never invents merge source or target branches.

## Scope Rules

- Test writing must happen before production behavior changes.
- Experiment branches are for alternative implementations, not refactor polish.
- Refactor happens only after the best experiment is merged into the task branch.
- Do not modify unrelated files. Before finishing a task, inspect the planner-controlled diff and verify scope.
- If new required work exceeds the current task, record it as a new task or return to planning.

## Fundamental Rules

### Rule 4: Uncertainty → Question

**Rule:** If a task allows more than one interpretation of mechanism, integration approach, or if you are uncertain about system boundaries — you MUST ask a question. Do not guess. Do not improvise. Do not write code based on assumptions.

**When to ask a question:**
- Unclear which mechanism the task uses (internal or external)
- Unclear which files to touch and which not
- Unclear what to consider "immutable"
- Risk that the solution will break the existing architecture

**When NOT to ask a question:**
- The task is unambiguous
- All boundaries are clear
- The mechanism is explicitly defined

**Deduction:** One question is better than an hour of rewriting a wrong solution.

### Rule 5: Priorities and Conflicts

**Priority hierarchy (highest to lowest):**

1. Direct user instructions — if the user said "change X" or "do not touch X", this overrides everything.
2. Fundamental rules — rules 1-4 apply when there are no direct instructions.
3. Technical criteria — when rules and instructions do not give a clear answer, you decide based on technical criteria.

**When instructions contradict each other:**

If a rule forbids touching file X, but you see that the technically optimal solution requires changing X — you must:

1. Record in your working notes why the solution without changing X is impossible or extremely suboptimal.
2. Formulate a specific justification: what will break, what will fail, what will work incorrectly.
3. Offer the user an alternative: "I recommend changing X because... But if you insist on keeping X unchanged, here is an alternative that will work worse: ..."
4. The final decision is always the user's.

**Deduction:** You do not silently break rules. If technically necessary to break one — you explain why and ask for permission.

## manual-compact

Preserve the plan id, active task id, active experiment id, exact branch, current step, task artifact paths, verification results, selected candidate state, completed experiment summaries, open risks, and exact next action. After compaction, call `planner_status`.

For `compact_experiment`, reload `task.md`, `tdd.md`, tests, verify notes, and prior experiment summaries. For `compact_task`, reload full `plan.md` before choosing the next task.

## auto-compact

Call `planner_status` immediately. Do not continue editing from chat memory. Restore the exact task and experiment from persisted state, inspect the git gate, then reread the artifacts required by the current step. Read source files only when the exact action needs details not present in the artifacts. If scope may have changed, reread full `plan.md`.

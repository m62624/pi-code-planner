# experiment

## Purpose

Explore multiple implementation candidates for one active task. Each experiment branch represents one distinct approach, one commit, and one durable summary.

## Attempt Lifecycle

1. Define an attempt id and a short intent.
2. Use `planner_git_create_experiment_branch`.
3. Implement only one approach during `run_experiment`.
4. Run focused checks.
5. Commit through `planner_git_commit`.
6. Confirm the worktree is clean.
7. Write a durable experiment summary.
8. Request `compact_experiment`.
9. At `select_experiment`, either:
   - continue to `start_experiments` for another genuinely different attempt, or
   - select the best completed attempt with `planner_git_select_experiment` and continue to merge.

## Attempt Budget

Use the attempt count, stop criteria, and project-specific evaluation rules recorded in task artifacts or append instructions. If none are specified, produce enough distinct candidates to expose meaningful tradeoffs without generating cosmetic variants.

Do not create another attempt when:
- all reasonable implementations are equivalent
- a hard project constraint leaves only one viable design
- additional variants would only rename symbols or rearrange syntax

Record the reason when stopping early.

## Summary Format

For every attempt record:
- intent and implementation approach
- changed files and symbols
- checks run and results
- correctness evidence
- project style fit
- simplicity
- maintainability
- performance considerations when relevant
- integration risk
- strengths
- weaknesses
- unresolved risks
- numeric comparison values using the task-specific criteria

## Selection Rules

- Compare summaries, not chat memory.
- Choose the best attempt id only. Never invent merge branches.
- Merge through `planner_git_merge_selected_experiment`.
- Unselected experiment branches are temporary evidence and must be removed by controlled cleanup after merge.
- Refactor polish happens after selected merge on the task path, not inside experiment candidates.

## manual-compact

Preserve the active task id, active attempt id, attempt branch, commit, checks, summary path, numeric evidence, strengths, weaknesses, prior attempt summaries, remaining attempt budget, and exact next decision. After compaction, call `planner_status`, reload `task.md`, `tdd.md`, tests, verify notes, prior summaries, and `discovery.md`. Do not reread the whole project by default.

## auto-compact

Call `planner_status` immediately. Reload the active experiment from persisted state and read durable summaries before deciding whether to continue, retry, or select. Do not treat an uncommitted attempt as complete.

## Experimentation & Hypotheses Diagnostics

### 1. Experiment Setup Failures
- **Attempt ID Resolution**: If an attempt branch fails to create, check if the active task branch exists and is checked out.
- **Experiment Branch Isolation**: Ensure that changes made in one experiment do not bleed into another. Always start each experiment from a clean task branch.
- **Merge Conflicts**: If merging an experiment fails, identify the exact conflicting lines. Do not guess how to resolve them; look at the state of both branches.

### 2. Resolution Protocol
1. Revert any uncommitted experiment edits if the hypothesis is disproven.
2. Choose the best experiment based on clear evidence (test coverage, simplicity, performance).
3. If all experiments fail, discard the branch and return to planning.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

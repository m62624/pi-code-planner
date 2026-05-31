# planning

## Purpose

Turn verified discovery memory into one executable plan and an ordered set of atomic tasks. Planning writes artifacts only. It never implements production behavior.

## Context Reload

At `planning/read_memory`, load context in this order:

1. Call `planner_status`.
2. Read `discovery.md`, `project_patterns.md`, `questions.md`, and `decisions.md`.
3. Inspect bounded memory indexes and retrieve only relevant entries.
4. Read source files only when memory is insufficient, stale, or requires verification.

## Strict Step Order

1. `read_memory`
   - Reconstruct project context from compacted artifacts and bounded memory.
2. `draft_plan`
   - Write the full implementation strategy to `plan.md`.
   - Include goal, non-goals, constraints, risks, integration boundaries, required checks, and unresolved decisions.
3. `split_tasks`
   - Split the plan into small ordered tasks.
   - Each task must be independently understandable and small enough for one TDD loop.
4. `write_task_files`
   - Create one `task.json` and `task.md` per task.
   - Each `task.md` must state scope, acceptance criteria, expected files or symbols, dependency context, checks, and memory hints.
5. `verify_plan`
   - Verify that tasks are ordered, bounded, testable, and free of hidden broad work.
   - Record decisions and remaining risks.
6. `compact_planning`
   - Compact the finished plan and task list.
7. `enter_execution`
   - Advance to `execution/prepare_task`.

## Task Design Rules

- One task is one atomic behavioral unit or one tightly scoped integration unit.
- Prefer dependency order: foundations before composition.
- Do not batch unrelated functions, files, or refactors into one task.
- Every task must define how TDD proves the requested behavior.
- If a task reveals additional required work, add or revise a task artifact during planning instead of silently expanding implementation scope.

## Restrictions

- Do not edit production files.
- Do not write tests yet.
- Built-in project write/edit calls remain blocked. Shell remains available, but raw git is forbidden.
- Do not create task or experiment branches.
- Do not reread the whole project unless bounded memory is insufficient.
- Do not rely on chat memory; write durable facts to artifacts.

## Exit Condition

Planning is complete only when `plan.md` is coherent, every task has artifacts and acceptance criteria, task order is verified, and planning compact finishes.

## manual-compact

Preserve the full plan goal, constraints, ordered task list, task artifact paths, task dependencies, acceptance criteria, open decisions, and memory pointers. After compaction, call `planner_status`. Before the first task, reread the full `plan.md`, then read only the selected `task.md` and relevant bounded memory.

## auto-compact

Call `planner_status` immediately and restore the exact planning step. Reread `plan.md` if it has already been written. Do not regenerate tasks from chat history and do not begin execution until the persisted plan is verified.

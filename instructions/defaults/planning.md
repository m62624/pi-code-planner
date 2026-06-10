# planning

## Purpose

Turn verified discovery context into one executable plan and an ordered set of atomic tasks. Planning writes artifacts only. It never implements production behavior.

## Context Reload

At `planning/read_context`, load context in this order:

1. Call `planner_status`.
2. Read `discovery.md`, `questions.md`, and `decisions.md`.
3. Read specific source files only when the recorded discovery context is insufficient.

## Strict Step Order

1. `read_context`
   - Reconstruct project context from compacted artifacts.
   - If `decisions.md` contains a Change Request, treat this as a follow-up planning pass. Reread the Post-Implementation Snapshot in `discovery.md`, especially `Completed Work` and `Remaining Work`.
2. `draft_plan`
	- Write the full implementation strategy to `plan.md`.
	- Include goal, non-goals, constraints, risks, integration boundaries, required checks, and unresolved decisions.
	- In a follow-up planning pass, preserve the existing completed plan history. Append or revise only the sections needed for the change request; do not replace `plan.md` wholesale and do not repeat work already listed under `Completed Work`.
	- For follow-up work, add a clearly labeled revision section with what remains and why the previous implementation was rejected.
3. `split_tasks`
	- Split the plan into small ordered tasks.
	- Each task must be independently understandable and small enough for one TDD loop.
	- In a follow-up planning pass, existing completed task artifacts are history. Create new revision task IDs for new work; do not reuse a completed task ID.
4. `write_task_files`
	- Call `planner_task_upsert` once per behavioral task.
	- Provide semantic fields only: task id, title, objective, scope, and acceptance criteria.
	- The wrapper creates `task.json`, `task.md`, and empty TDD lifecycle artifacts. Do not write task JSON manually.
	- Each `task.md` must state scope, acceptance criteria, expected files or symbols, dependency context, and checks.
	- In a follow-up planning pass, call `planner_task_upsert` only for new or still-pending revision tasks. Completed task IDs are immutable audit history.
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
- Never create standalone plan tasks named like "write tests", "add mocks", "test the implementation", or "verify the code".
- Tests, mocks, fixtures, and checks belong inside the individual behavioral task that needs them. Each task runs its own tests-first TDD loop before production edits.
- A separate testing task is allowed only when test infrastructure itself is the requested product behavior or an explicit shared prerequisite, not merely because implementation needs tests.
- If a task reveals additional required work, add or revise a task artifact during planning instead of silently expanding implementation scope.
- For a change request after a completed pass, use new revision task IDs such as `fix-storage-root-revision` instead of reopening completed task IDs.

## Restrictions

- Do not edit production files.
- Do not write tests yet.
- Built-in project write/edit calls remain blocked. Shell remains available, but raw git is forbidden.
- Do not create task branches.
- Do not reread the whole project unless recorded discovery context is insufficient.
- Do not rely on chat memory; write durable facts to artifacts.

## Exit Condition

Planning is complete only when `plan.md` is coherent, every task has artifacts and acceptance criteria, task order is verified, and planning compact finishes.

## Doubt Checkpoint

Before finishing planning, doubt the plan shape:

- Does every task prove one behavioral unit, or did you hide several tasks in one broad item?
- Does each task own its tests-first evidence instead of creating standalone test/implementation/verify tasks?
- Are completed tasks preserved as history during follow-up planning?
- Does `plan.md` explain remaining work without repeating work already completed?

If doubt remains, revise `plan.md` or task artifacts before entering execution. Do not rely on memory from chat.

## Fundamental Rules

### Rule 3: Integration vs New Entity

**Prerequisite:** This rule applies ONLY if the user did not explicitly ask to modify file X. If the user said "change X" — their word is final.

**Core principle:** When adding new functionality to an existing project, you must decide: integrate into existing code or create a new entity/module/class.

**Criteria for integrating into existing code (when you may touch existing files):**

- The new functionality is a natural continuation of the existing logic of this file/module
- Changes are minimal and do not restructure the existing code
- The existing file already contains similar mechanisms, and the new functionality fits the same pattern
- Adding new code does not require refactoring or rebuilding the existing structure

**Criteria for creating a new entity (when you must NOT touch existing files, even if they seem "related"):**

- The existing code is already a complete, logically closed entity (module, class, service)
- Integration would require changing the public interface of the existing entity
- The new functionality has a distinct responsibility from the existing one
- The existing code follows a pattern that does not support internal extension (e.g., a module that must remain unchanged)

**How to decide:**
1. Look at the existing code. What does it do? What is its responsibility?
2. Look at the new functionality. What is its responsibility?
3. If responsibilities match or the new one is a subset of the existing → integrate.
4. If responsibilities differ or the new one is a parallel entity → create a new entity.

**Deduction:** You do not touch existing files if the new functionality is not a natural continuation of their responsibility. You create a new entity if the existing one is already complete.

## manual-compact

Preserve the full plan goal, constraints, ordered task list, task artifact paths, task dependencies, acceptance criteria, open decisions, and `discovery.md`. After compaction, call `planner_status`. Before the first task, reread the full `plan.md`, then read only the selected `task.md` and use focused project search when context is insufficient.

## auto-compact

Call `planner_status` immediately and restore the exact planning step. Reread `plan.md` if it has already been written. Do not regenerate tasks from chat history and do not begin execution until the persisted plan is verified.

## Planning & Task Diagnostics

### 1. Decomposition Failures
- **Too Large Scope**: If a task description contains multiple unrelated behaviors, split it into smaller sub-tasks.
- **Missing Dependencies**: Ensure task dependencies are ordered correctly (e.g., database schema changes must be executed before API handlers).
- **Incoherent Task ID**: Use lowercase, clean alphanumeric IDs.

### 2. Troubleshooting Planning Errors
- If verification fails during planning, re-evaluate the architecture. Ensure files listed in the task scope actually exist or are planned to be created.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

# planning

## Purpose

Turn verified discovery context into one executable plan and an ordered set of atomic tasks. Planning writes artifacts only. It never implements production behavior.

## Context Reload

At `planning/read_context`, load context in this order:

1. Call `planner_status`.
2. Read `discovery.md`, `questions.md`, and `decisions.md` via `planner_artifact_read` (one call per `artifact`), not the built-in read tool.
3. Use `planner_contract_route/read` for applicable AGENTS.md chains before extra source reads.
4. Read specific source files only when recorded discovery context and local contracts are insufficient.

## Strict Step Order

1. `read_context`
   - Reconstruct project context from compacted artifacts.
   - If `decisions.md` contains a Change Request, treat this as a follow-up planning pass. Reread the Post-Implementation Snapshot in `discovery.md`, especially `Completed Work` and `Remaining Work`.
2. `draft_plan`
   - Write the full implementation strategy to `plan.md` through `planner_plan_submit` (pass the full content; it saves the file atomically).
   - Include goal, non-goals, constraints, risks, integration boundaries, required checks, and unresolved decisions.
   - In a follow-up planning pass, preserve the existing completed plan history. Append or revise only the sections needed for the change request; do not replace `plan.md` wholesale and do not repeat work already listed under `Completed Work`. Add a clearly labeled revision section with what remains and why the previous implementation was rejected.
3. `split_tasks`
   - Split the plan into small ordered tasks, each independently understandable and small enough for one TDD loop.
   - In a follow-up planning pass, existing completed task artifacts are history. Create new revision task IDs for new work; do not reuse a completed task ID.
4. `write_task_files`
   - Call `planner_task_upsert` once per behavioral task with semantic fields only: task id, title, objective, scope, acceptance criteria, and optional Local Contract Context fields. The wrapper creates `task.json`, `task.md`, and empty TDD lifecycle artifacts; do not write task JSON manually.
   - Each `task.md` must state scope, acceptance criteria, expected files or symbols, dependency context, checks, and the relevant AGENTS.md chain when known.
   - In a follow-up planning pass, call `planner_task_upsert` only for new or still-pending revision tasks. Completed task IDs are immutable audit history.
5. `verify_plan` — verify tasks are ordered, bounded, testable, and free of hidden broad work. Record decisions and remaining risks.
6. `compact_planning` — compact the finished plan and task list.
7. `enter_execution` — advance to `execution/prepare_task`.

## Task Design Rules

- One task is one atomic behavioral unit or one tightly scoped integration unit.
- Prefer dependency order: foundations before composition.
- Do not batch unrelated functions, files, or refactors into one task.
- Every task must define how TDD proves the requested behavior.
- Never create standalone plan tasks named like "write tests", "add mocks", "test the implementation", or "verify the code". Tests, mocks, fixtures, and checks belong inside the behavioral task that needs them; each task runs its own tests-first TDD loop before production edits.
- A separate testing task is allowed only when test infrastructure itself is the requested product behavior or an explicit shared prerequisite.
- If a task reveals additional required work, add or revise a task artifact during planning instead of silently expanding implementation scope.
- For a change request after a completed pass, use new revision task IDs such as `fix-storage-root-revision` instead of reopening completed task IDs.

## Restrictions

- Do not edit production files or write tests yet.
- Built-in project write/edit calls remain blocked. Shell remains available, but raw git is forbidden.
- Do not create task branches.
- Do not reread the whole project unless recorded discovery context is insufficient.
- Do not ignore local contracts. If AGENTS.md files exist, task scope should preserve the relevant contract chain or explain why none applies.
- Do not rely on chat memory; write durable facts to artifacts.

## Exit Condition

Planning is complete only when `plan.md` is coherent, every task has artifacts and acceptance criteria, task order is verified, and planning compact finishes.

## Evidence Discipline

Treat the plan as a falsifiable design, not a confident story.

- Every task must map to discovered evidence, user-approved requirements, or an explicit assumption.
- Do not remove or skip tasks because the implementation looks easy.
- If a change request follows completed work, preserve completed work and add revision tasks instead of rewriting history.
- If a risk cannot be tested or inspected, record the unresolved decision before execution.

## Doubt Checkpoint

Before finishing planning, doubt the plan shape:

- Does every task prove one behavioral unit, or did you hide several tasks in one broad item?
- Does each task own its tests-first evidence instead of creating standalone test/implementation/verify tasks?
- Are completed tasks preserved as history during follow-up planning?
- Does `plan.md` explain remaining work without repeating work already completed?

If doubt remains, revise `plan.md` or task artifacts before entering execution. Do not rely on chat memory.

## Fundamental Rule: Integration vs New Entity

**Prerequisite:** this applies ONLY when the user did not explicitly ask to modify file X. If the user said "change X", their word is final.

When adding new functionality to an existing project, decide: integrate into existing code, or create a new entity/module/class.

**Integrate into existing code when:** the new functionality is a natural continuation of the file/module's logic; changes are minimal and do not restructure existing code; the file already contains similar mechanisms that fit the same pattern; no refactoring of the existing structure is required.

**Create a new entity (do NOT touch existing files, even "related" ones) when:** the existing code is already a complete, logically closed entity; integration would change its public interface; the new functionality has a distinct responsibility; the existing code follows a pattern that does not support internal extension.

**How to decide:** compare responsibilities. If the new responsibility matches or is a subset of the existing one → integrate. If responsibilities differ or it is a parallel entity → create a new entity. You do not touch existing files when the new functionality is not a natural continuation of their responsibility.

## Diagnostics

- **Too-large scope:** if a task description contains multiple unrelated behaviors, split it.
- **Missing dependencies:** order tasks correctly (e.g., schema changes before API handlers).
- **Incoherent task id:** use lowercase, clean alphanumeric ids.
- If verification fails during planning, re-evaluate the architecture and confirm files in task scope exist or are planned.

## manual-compact

Preserve the full plan goal, constraints, ordered task list, task artifact paths, dependencies, acceptance criteria, open decisions, and `discovery.md`. After compaction, call `planner_status`. Before the first task, reread the full `plan.md` via `planner_artifact_read`, then read only the selected `task.md` (`planner_artifact_read` `artifact: "task"`) and use focused project search when needed.

## auto-compact

Call `planner_status` immediately and restore the exact planning step. Reread `plan.md` via `planner_artifact_read` if it has already been written. Do not regenerate tasks from chat history and do not begin execution until the persisted plan is verified.

## If You Do Not Know What To Do Next

The `planner_finish_step` result names your next step, its goal, and the worktree to work in — follow it. Call `planner_status` only when you need the full step rule or stage instruction, or when you are unsure.

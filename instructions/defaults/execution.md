# execution

## Purpose

Execute exactly one active task at a time through tests-first development, implementation, AGENTS.md contract check, mandatory refactor review, final checks, merge, and task compact.

## Context Reload Policy

- At `prepare_task`, call `planner_status`, reread the full `plan.md`, read answered `questions.md` and `decisions.md`, read the selected `task.md`, then inspect `discovery.md` and use focused project search only if needed.
- If `task.md` lists a Local Contract Context, call `planner_contract_route/read` before source reads. AGENTS.md files are repository-owned routing memory; higher levels route, nearest levels explain.
- During one task, reread `task.md`, `tdd.md`, `refactor.md`, and focused source files only when the current action needs details that are not already recorded.
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
   - Append changed test files and intent to `tdd.md`.
   - If project files changed, commit through planner git before continuing.
4. `run_failing_tests`
   - Run focused checks and prove that tests detect the missing behavior.
   - Record exact command, cwd, and failing signal in `tdd.md`.
5. `implement_task`
   - Implement only the behavior required by `task.md` and `tdd.md`.
   - Run focused checks, update `tdd.md` with results, and commit through planner git if files changed.
6. `contract_check`
   - Inspect the green task diff and decide whether durable AGENTS.md local contracts changed.
   - Call `planner_contract_check`.
   - If the tool reports an update is needed, call `planner_contract_upsert` and commit the AGENTS.md change.
   - Add only durable domain guidance. Do not store task trivia or create AGENTS.md in every folder.
7. `refactor_task`
   - Challenge the implementation without changing behavior.
   - Write `refactor.md` with a concrete KISS review, changes applied, and decisions to keep code unchanged.
   - Commit through planner git if files changed.
8. `run_final_tests`
   - Run final focused and integration checks from the planner worktree.
   - Record final check results and scope review in `refactor.md`.
9. `merge_task_to_plan`
   - Merge the task branch into the plan branch through the planner wrapper.
   - Call `planner_status` after merge.
10. `compact_task`
   - Compact the completed task result if enabled.
11. `select_next_task`
   - Choose `execution/prepare_task` for the next task or `finalize/verify_plan_branch` when execution is complete.

## Atomic Unit Rules

- A commit alone does not finish an atomic unit.
- After every planner-controlled commit or merge, call `planner_status` and continue the persisted state-machine step.
- Dirty worktree is allowed while implementing a running step, but must be resolved before merge boundaries.
- Built-in project write/edit calls are enabled only during `write_tests`, `implement_task`, and `refactor_task`. During `contract_check`, AGENTS.md changes must go through `planner_contract_upsert`, not raw write/edit.
- Never edit the original checkout while a planner worktree is active. Continue inside the worktree session reported by `planner_status`.
- Run every project command from the worktree path reported by `planner_status`. This includes focused tests, full tests, builds, type checks, linters, formatters, generators, package scripts, compilers, and project-specific verification commands, regardless of language or tooling.
- Before recording a successful check, confirm that its shell cwd was the planner worktree, not the original checkout.
- Use `planner_status` after every wrapper result.
- Raw git is forbidden.
- The model chooses task ids only. It never invents merge source or target branches.

## Scope Rules

- Test writing must happen before production behavior changes.
- Do not modify unrelated files. Before finishing a task, inspect the planner-controlled diff and verify scope.
- Refactor is mandatory design review, not formatter/linter output. Passing checks do not prove that no refactor is needed.
- If new required work exceeds the current task, record it as a new task or return to planning.

## Doubt Checkpoint

Before finishing any execution step, doubt the proof:

- What artifact or command proves this exact step is complete?
- Did the test fail before implementation for the intended reason?
- Did the fix stay inside active task scope?
- Did `contract_check` prove whether AGENTS.md must be updated, and are pending upserts resolved?
- Did refactor review challenge the implementation, not just repeat that checks pass?
- Are temporary debug logs, probes, or scratch files removed before commit?

If doubt remains, run one focused probe or record the risk. Do not add broad tests or unrelated cleanup only to increase confidence.

## Planner Skill Memory

When a task resolves a verified reusable lesson, use `planner_skill_create` to save it for future planner sessions. Good candidates are repeated failure patterns, non-obvious debug probes, state-machine mistakes, stale context issues, or exact workflow rules that prevented a real bug.

Do not create a skill for ordinary implementation notes, task summaries, broad advice, or unproven suspicions. The skill body should be written in `metadata.skillLanguage`; the wrapper writes frontmatter and updates the planner skill index.

## Fundamental Rules

### Rule 4: Uncertainty -> Question

**Rule:** If a task allows more than one interpretation of mechanism, integration approach, or if you are uncertain about system boundaries, ask a question. Do not guess. Do not write code based on assumptions.

**When to ask a question:**
- Unclear which mechanism the task uses.
- Unclear which files to touch and which not.
- Unclear what to consider immutable.
- Risk that the solution will break the existing architecture.

**When not to ask a question:**
- The task is unambiguous.
- All boundaries are clear.
- The mechanism is explicitly defined.

## manual-compact

Preserve the plan id, active task id, exact branch, current step, task artifact paths, TDD evidence, refactor findings, final checks, open risks, and exact next action. After compaction, call `planner_status`.

For `compact_task`, reload full `plan.md` before choosing the next task.

## auto-compact

Call `planner_status` immediately. Do not continue editing from chat memory. Restore the exact task from persisted state, inspect the git gate, then reread the artifacts required by the current step. Read source files only when the exact action needs details not present in the artifacts. If scope may have changed, reread full `plan.md`.

## KISS Execution & Footprint Discipline

### 1. The Principle of Minimal Footprint
- **One File, One Goal**: Modify only files required by the active task. Do not polish adjacent code or run arbitrary refactorings during implementation.
- **Limit Function Proliferation**: Avoid new files or helpers unless the existing codebase layout strictly demands it.
- **KISS Code**: Simple, readable, direct code beats speculative abstraction.

### 2. Implementation Boundaries
- **No Speculative Implementations**: Do not implement handling logic for future tasks or edge cases that have not been requested by the active task or verified by a TDD test.

## Execution & Runtime Diagnostics

### 1. Test Failures & Stack Traces
- **Locate Error Source**: When a test fails, extract the exact file path and line number. Do not rely on summary output only.
- **Isolate Module Interfaces**: Check exact arguments and outputs at the failing boundary.
- **Verify Execution Cwd**: Ensure all commands run from the specific worktree directory reported by `planner_status`.

### 2. Algorithmic Pivot Protocol
- **Stuck Loop detection**: If you make 3 attempts to fix a bug and the same test failure persists, stop.
- **Trace Backwards**: Open `tdd.md` and re-read boundary conditions.
- **Verify Mock Integrity**: Ensure mocks are not hiding the real bug or returning stale data.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

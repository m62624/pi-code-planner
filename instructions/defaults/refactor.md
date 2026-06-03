# refactor

## Purpose

Challenge and improve the selected task implementation after the best experiment has been merged. Refactor changes structure, clarity, naming, duplication, or integration quality without changing requested behavior.

KISS does not mean avoiding advanced language features. Traits, interfaces, generics, macros, or other abstractions are valid when the current task needs them. KISS means every abstraction, branch, type, helper, and extension point must justify its existence through the current behavior or existing project design. Do not add flexibility for imagined future work.

## Required Process

1. Read `task.md`, `tdd.md`, test artifacts, selected experiment summary, and focused source files only when needed.
2. Inspect the current task-branch diff through planner wrappers.
3. Question the implementation actively:
   - Can any helper, abstraction, branch, conversion, or validation path be removed or made clearer?
   - Is any code duplicated, speculative, over-generalized, or implemented for future use rather than the current task?
   - Does the implementation match existing project conventions and confirmed user decisions?
   - Are signatures and effects still as small and explicit as possible?
4. Write `refactor.md` with concrete findings, KISS review, changes applied, and justified decisions to keep code unchanged.
5. Apply only behavior-preserving changes.
6. Run focused tests from the worktree path reported by `planner_status` after each meaningful refactor group.
7. Commit through planner wrappers if files changed.
8. Update task artifacts when the refactor changes relevant implementation details.
9. Commit the refactor if project files changed.

## Restrictions

- Do not add new scope.
- Do not weaken tests to make refactor pass.
- Do not change public API unless the active task explicitly requires it.
- Do not perform speculative cleanup outside the active task.
- Do not claim that refactor is unnecessary merely because tests, Clippy, a linter, or a formatter pass. Tool output is evidence, not design review.
- Do not run project tests, builds, formatters, or other verification commands from the original checkout. Use the planner worktree as shell cwd.
- If a behavior change is required, stop and return to planning or create a new task.
- Do not use raw git.

## Exit Condition

Refactor is complete only when `refactor.md` contains a concrete review, checks pass, the diff stays within task scope, and changed files are committed.

## manual-compact

Preserve selected candidate context, refactor intent, changed files, checks, commit, and any deferred cleanup. After compaction, call `planner_status` before continuing.

## auto-compact

Call `planner_status` immediately. Reload task artifacts, selected experiment summary, and verify notes. Confirm whether refactor changes were committed before resuming.

## Refactoring & Code-Safety Diagnostics

### 1. Refactoring Regressions
- **Behavior Changes**: Refactoring must not change external behavior. If a test fails after refactoring, you have violated this rule.
- **Unused Code**: Ensure refactored paths remove old, dead code cleanly.
- **Lint Violations**: Refactoring often introduces unused imports or formatting issues. Always run formatting/linting tools immediately.

### 2. Diagnostic Steps
1. Revert to the clean task branch HEAD if a refactoring attempt breaks tests and cannot be easily fixed.
2. Refactor in small, incremental steps, committing after each successful step.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

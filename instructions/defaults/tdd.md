# tdd

## Purpose

Use strict tests-first development for every execution task. Production implementation is forbidden until the active task has a written TDD plan and a demonstrated failing, mock, or contract signal.

## Required Sequence

1. During `write_tdd_plan`, read `task.md`, relevant memory entries, existing tests, and project test conventions.
2. Write `tdd.md` with:
   - behavior under test
   - arguments, return value, errors, and integration points
   - edge cases
   - fixtures and mocks
   - focused test commands
   - expected failure or contract signal before implementation
3. During `write_tests`, write tests and required test harness wiring only. Record them in `tests.md`. If project files changed, commit through `planner_git_commit`, refresh memory file-by-file, verify it, and sync checkpoint before continuing.
4. During `run_failing_tests`, execute focused checks and record evidence in verify artifacts.
5. Begin production edits only during `run_experiment`.
6. During `run_final_tests`, rerun focused tests and required broader integration checks.

## Test Signal Rules

- Run every test, build, and verification command from the worktree path reported by `planner_status`. Never run project checks from the original checkout while a planner plan is active.
- The rule is toolchain-independent: use the project's actual commands, whether they are package scripts, compiler commands, task runners, or custom scripts.
- Prefer a real failing test when the missing behavior can execute locally.
- Use a mock test when the external dependency is unavailable or unsafe to invoke.
- Use a contract test when the critical behavior is an interface, schema, command construction, or integration boundary.
- If a test cannot run locally, document why and still add the strongest deterministic mock or contract test available.
- A test that passes before implementation without proving the missing behavior is not sufficient.

## Editing Rules

- Test steps may edit any files required to create tests, fixtures, mocks, and test harness integration.
- Do not change production behavior during `write_tests`.
- Do not perform unrelated cleanup while writing tests.
- Before finishing the task, inspect the planner-controlled diff and confirm every changed file belongs to the task.

## Verification Record

Record:
- exact commands run
- worktree cwd used for each command
- expected and actual result
- failing signal before implementation
- passing signal after implementation
- skipped checks and reasons
- edge cases covered

## manual-compact

Preserve the active task id, `tdd.md` path, test artifact paths, failing signal, commands, fixtures, covered edge cases, skipped checks, and final verification state. After compaction, call `planner_status` before continuing.

## auto-compact

Call `planner_status` immediately. Reload `task.md`, `tdd.md`, test artifacts, and relevant bounded memory. Do not skip the failing-test requirement because earlier chat context was compacted.

# tdd

## Purpose

Use strict tests-first development for every execution task. Production implementation is forbidden until the active task has a written TDD plan and a demonstrated failing, mock, or contract signal.

## Required Sequence

1. During `write_tdd_plan`, read answered `questions.md`, `decisions.md`, `task.md`, existing tests, and project test conventions.
2. Write `tdd.md` with:
   - behavior under test
   - arguments, return value, errors, and integration points
   - edge cases
   - fixtures and mocks
   - focused test commands
   - expected failure or contract signal before implementation
3. During `write_tests`, write tests and required test harness wiring only. Record changed files, intent, and expected signal in `tdd.md`. If project files changed, commit through `planner_git_commit` before continuing.
4. During `run_failing_tests`, execute focused checks and record the exact failing signal in `tdd.md`.
5. Begin production edits only during `implement_task`.
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

Record in `tdd.md`:
- exact commands run
- worktree cwd used for each command
- expected and actual result
- failing signal before implementation
- passing signal after implementation
- skipped checks and reasons
- edge cases covered

## manual-compact

Preserve the active task id, `tdd.md` path, failing signal, commands, fixtures, covered edge cases, skipped checks, and final verification state. After compaction, call `planner_status` before continuing.

## auto-compact

Call `planner_status` immediately. Reload `task.md`, `tdd.md`, and focused source files only when needed. Do not skip the failing-test requirement because earlier chat context was compacted.

## Smart TDD & Boundary Coverage (KISS-based TDD)

### 1. Mandatory Core Test Cases
For every code modification or feature, your test suite must cover the following test cases before writing any production code:
- **Baseline (Happy Path)**: The exact expected outcome for typical valid input.
- **Minimum Limit**: Test with empty inputs, zero, empty arrays, or minimum bounds.
- **Maximum Limit**: Test with maximum bounds, long strings, large arrays, or overflow limits.
- **Danger Zone (Edge Cases & Errors)**: Test with null, undefined, invalid type formats, or error paths.

### 2. Implementation Footprint Restriction
- **No Speculative Coding**: Only write the absolute minimum amount of production code required to make your TDD tests pass.
- **Do Not Guess Behaviors**: If you write code to handle a case that is not covered by a TDD test, you are violating this rule. Add a test for that case first, then implement it.

## TDD & Test-Harness Diagnostics

### 1. Test Harness Errors
- **Compilation Failures**: If the test code fails to compile, fix compiler/lint issues before focusing on the behavior test.
- **No Failing Signal**: If the test passes before you write the production code, the test is invalid or testing the wrong code path.
- **Broken Mocks**: If the test hangs, check if your mocks are waiting for network/database calls that aren't mocked.

### 2. Algorithmic Pivot Flow
- **Doubt the Test**: If the implementation is correct but the test still fails, analyze the test assertions. Verify that expectations match the method signature.
- **Synchronous Checks**: Verify files and import paths manually before running the test runner to avoid generic module-not-found errors.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

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
   - Before finishing `run_failing_tests`, add `## Pre-Implementation Proof Contract`.
   - Record the exact missing-behavior signal, intended production path, success signal, and files that must stay out of scope.
5. Begin production edits only during `implement_task`.
6. Before finishing `implement_task`, add `## Post-Implementation Counterexample Review`.
   - Record the smallest counterexample, boundary value, opposite case, regression risk, scope check, and action.
   - If the counterexample is real, add a test or explicitly record why it is out of scope before continuing.
   - If resolving the task produced a reusable verified lesson, call `planner_skill_create` to save it for future planner sessions. Do not create a skill for ordinary task summaries.
7. During `contract_check`, call `planner_contract_check`.
   - First decide the action: `no_update`, `upsert_existing`, or `create_new`.
   - Use `upsert_existing` if a writable AGENTS.md already exists in the affected domain and task work changed durable architecture, domain routing, test/check conventions, state-machine behavior, storage/recovery rules, or module boundaries.
   - Use `create_new` if no writable AGENTS.md exists in the affected domain AND the task introduced a meaningful new domain boundary (new module, new storage pattern, new state machine behavior, new integration point) that future planner sessions should know about.
   - Use `no_update` only if no writable AGENTS.md exists AND the change is entirely self-contained with no new domain rules, OR if an AGENTS.md exists and the diff introduces nothing durable. Record concrete evidence for `no_update`; absence of AGENTS.md alone is not sufficient evidence.
   - After `planner_contract_check`, call `planner_contract_upsert` if the action is `upsert_existing` or `create_new`.
8. During `run_final_tests`, rerun focused tests and required broader integration checks.
9. Before finishing `merge_task_to_plan`, add `## Task Merge Scope Audit`.
   - Confirm acceptance criteria coverage, changed-file scope, commands run, debug cleanup, commit message fit, and branch drift check.

## Test Signal Rules

- Run every test, build, and verification command from the worktree path reported by `planner_status`. Never run project checks from the original checkout while a planner plan is active.
- The rule is toolchain-independent: use the project's actual commands, whether they are package scripts, compiler commands, task runners, or custom scripts.
- Prefer a real failing test when the missing behavior can execute locally.
- Use a mock test when the external dependency is unavailable or unsafe to invoke.
- Use a contract test when the critical behavior is an interface, schema, command construction, or integration boundary.
- If a test cannot run locally, document why and still add the strongest deterministic mock or contract test available.
- A test that passes before implementation without proving the missing behavior is not sufficient.
- A module-not-found, import error, or file-does-not-exist failure is only a harness/bootstrap signal. It is not a complete behavior proof unless the test already contains assertions for the task behavior and fails again or passes for that behavior after implementation.
- Placeholder, stub, fake, TODO-only, or hardcoded implementations do not satisfy green TDD. If a minimal implementation is intentionally narrow, the tests must prove the accepted behavior and the counterexample review must name what remains out of scope.

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

## Evidence Discipline

Treat TDD as the proof engine. Do not trust an implementation until the test signal changes for the intended reason.

- Red must prove missing behavior, not only a missing file/import/bootstrap problem.
- Green must prove the requested behavior, not only that the harness is quiet.
- If a counterexample is plausible, make it a test, record it as a non-goal with evidence, or mark the task blocked.
- Do not add broad tests to feel safer; add the smallest test that can falsify the current claim.

## Planner Skill Memory

`planner_skill_create` is future memory. Use it aggressively after a lesson is proven by a failing signal, debug probe, counterexample review, repeated mistake, stale-context recovery, or state-machine/tooling mistake that future planner sessions should avoid.

Create the skill before leaving the step that proved the lesson when the lesson is reusable. Do not postpone it to final summary unless the lesson only becomes clear at plan level.

Do not create skills for:
- ordinary task summaries
- project-specific paths that will not generalize
- unverified opinions
- broad advice like "write tests" or "debug carefully"

When creating a skill, write the skill body in `metadata.skillLanguage`. The wrapper writes `name` and `description` frontmatter and stores the skill under the planner extension library.

Required proof/audit sections:

```md
## Pre-Implementation Proof Contract
- failingSignal: exact failing test, command output, mock/contract failure, or documented reason no local failing signal is possible
- productionPath: files/functions expected to change
- successSignal: exact command or assertion expected to pass after implementation
- outOfScopeFiles: files or areas that must not be changed for this task

## Post-Implementation Counterexample Review
- counterexample: smallest input/user flow/state that could break the fix
- boundaryValue: boundary checked or explicit reason it is not relevant
- oppositeCase: opposite behavior checked or explicit reason it is not relevant
- regressionRisk: old behavior that could have been broken
- scopeCheck: whether the implementation stayed inside the task scope
- action: added test, recorded non-goal, or no action with evidence

## Contract Consistency Check
- action: no_update, upsert_existing, or create_new from planner_contract_check
- outcome: what changed and why it does or does not affect durable AGENTS.md memory
- domain impact: affected domain rule, or none with evidence
- recommended path: nearest meaningful AGENTS.md path or none
- changed files: files checked
- evidence: diff/test/artifact facts supporting the action

## Task Merge Scope Audit
- acceptanceCriteriaCovered: task acceptance criteria and evidence
- changedFilesMatchScope: changed files compared with task scope
- testsRun: exact focused and broader commands run
- debugRemoved: temporary logs/probes/scratch files removed
- commitMessageMatchesBehavior: latest planner commit describes behavior, not process
- branchDriftCheck: planner_status/git wrapper state showed expected task/plan branch state
```

## manual-compact

Preserve the active task id, `tdd.md` path, failing signal, commands, fixtures, covered edge cases, skipped checks, and final verification state. After compaction, call `planner_status` before continuing.

## auto-compact

Call `planner_status` immediately. Reload `task.md`, `tdd.md`, and focused source files only when needed. Do not skip the failing-test requirement because earlier chat context was compacted.

## Smart TDD & Boundary Coverage (KISS-based TDD)

### 1. Mandatory Core Test Cases
For every behavioral task, choose only the cases that falsify a real acceptance risk before writing production code:
- **Baseline (Happy Path)**: The exact expected outcome for typical valid input when the task changes that path.
- **Minimum Limit**: Empty inputs, zero, empty arrays, or minimum bounds only when boundaries are part of the behavior.
- **Maximum Limit**: Maximum bounds, long strings, large arrays, or overflow limits only when the task can plausibly break them.
- **Danger Zone (Edge Cases & Errors)**: Null, undefined, invalid formats, or error paths only when the task owns validation/error behavior.
- **No Reassurance Tests**: Do not add tests merely to feel safer. Add a test only when it would fail before the fix or protect a named requirement.

### 2. Implementation Footprint Restriction
- **No Speculative Coding**: Only write the absolute minimum amount of production code required to make your TDD tests pass.
- **Do Not Guess Behaviors**: If you write code to handle a case that is not covered by a TDD test, you are violating this rule. Add a test for that case first, then implement it.
- **Doubt the Test Itself**: A passing test can prove the wrong behavior. Before implementation, name the exact failure signal that proves the missing behavior.

## TDD & Test-Harness Diagnostics

### 1. Test Harness Errors
- **Compilation Failures**: If the test code fails to compile, fix compiler/lint issues before focusing on the behavior test.
- **No Failing Signal**: If the test passes before you write the production code, the test is invalid or testing the wrong code path.
- **Bootstrap-Only Failure**: If the only red signal is missing module/import/file, create the module, then rerun the focused test and verify behavior assertions fail or pass for the real task. Do not treat “file now exists” as task completion.
- **Broken Mocks**: If the test hangs, check if your mocks are waiting for network/database calls that aren't mocked.

### 2. Algorithmic Pivot Flow
- **Doubt the Test**: If the implementation is correct but the test still fails, analyze the test assertions. Verify that expectations match the method signature.
- **Synchronous Checks**: Verify files and import paths manually before running the test runner to avoid generic module-not-found errors.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

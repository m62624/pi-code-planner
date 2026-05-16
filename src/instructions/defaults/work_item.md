# pending

Goal: keep the item registered but inactive.
Allowed: read planner artifacts, ask a focused question, or transition to `ready` when the plan says this item is next.
Required tools: `planner_transition_work_item` only when moving to `ready`.
Forbidden: project reads outside the needed artifact context, project edits, tests, experiments, commits.
Exit condition: the item is selected as the next atomic unit.
Next stage: `ready`.

# ready

Goal: activate exactly one atomic work item on its managed child branch.
Allowed: confirm scope, expected files, expected tests, and dependencies from planner artifacts.
Required tools: call `planner_start_work_item` if the child branch is not active, then call `planner_transition_work_item` to move to `active`.
Forbidden: project edits, test edits, production edits, experiment branches, direct shell git.
Exit condition: the correct child branch is active and scope is clear.
Next stage: `active`.

# active

Goal: load the smallest project context needed to write the TDD plan.
Allowed: read focused files, search memory, inspect symbols, and update the work item artifact if needed.
Required tools: `planner_memory_search_symbols`, `planner_memory_get_symbol_context`, read-only project tools, then `planner_transition_work_item` to `tdd_prepare`.
Forbidden: project edits, test edits, production edits, experiment branches.
Exit condition: you know the behavior to test, the target files, and the verification command.
Next stage: `tdd_prepare`.

# tdd_prepare

Goal: write the TDD plan artifact before touching tests or production code.
Allowed: run read-only inspection such as `git diff --stat HEAD`, read focused source/test files, and write only the planner `tdd_plan.md` artifact.
Required order: first inspect current status/diff if needed; then write or update `tdd_plan.md`; then call `planner_transition_work_item` to `tdd_write_tests`.
Forbidden: production code edits, test code edits, experiment branches, implementation shortcuts, and skipping directly to a commit or experiment stage.
Exit condition: the TDD plan states the first failing test or mock/contract test to create, expected behavior, inputs, outputs, edge cases, failure modes, and verification commands.
Next stage: `tdd_write_tests`.

# tdd_write_tests

Goal: create the failing test before any production implementation.
Allowed: write or update test files only. Run focused tests to prove the new test fails for the expected reason.
Required order: start only after `tdd_plan.md` exists; write the focused test, mock test, or contract test first; run the focused test command; then `planner_transition_work_item` to `tdd_tests_commit`.
Forbidden: production code edits, moving to `tdd_tests_commit` before a test artifact exists, or claiming tests are unnecessary without explicit user/planner evidence. If behavior depends on unavailable external state or unsafe APIs, create a mock test or contract test instead of skipping tests.
Exit condition: at least one focused test exists and fails because the intended behavior is missing, or a mock/contract test exists that captures the intended behavior when a real failing test cannot run.
Next stage: `tdd_tests_commit`.

# tdd_tests_commit

Goal: create a test-only checkpoint on the child branch.
Allowed: run focused tests, inspect git status, adjust broken tests only if they do not touch production code.
Required tools: `planner_finish_work_item` or the planner-controlled commit path for the test-only checkpoint, then transition to `experiments_running`.
Forbidden: production code edits, experiment implementation before the test checkpoint exists, direct shell git commit.
Exit condition: tests are committed or checkpointed through planner tooling, and experiment branches can start from identical test evidence.
Next stage: `experiments_running`.

# experiments_running

Goal: produce multiple isolated implementation attempts against the same tests.
Allowed: for each attempt, call `planner_start_experiment`, edit production code on that experiment branch, run the same tests, and write attempt artifacts.
Required tools: `planner_start_experiment` for every attempt id; each attempt must have `plan.md`, `prompt.md`, `summary.md`, `verification.json`, `changed_files.json`, and `score.json`.
Forbidden: changing the test contract inside experiment branches, refactoring for polish, merging more than one candidate, deleting rejected branches before their evidence is recorded.
Exit condition: every required attempt has implementation, verification output, changed files, summary, and numeric score.
Next stage: `candidate_selection`.

# candidate_selection

Goal: choose exactly one winning implementation attempt.
Allowed: compare attempt artifacts, scores, diff size, correctness, project style fit, maintainability, performance, and integration risk.
Required tools: `planner_select_experiment` for the winning attempt after scoring all attempts.
Forbidden: selecting without recorded scores, selecting multiple winners, doing new implementation work.
Exit condition: one candidate is selected and every rejected attempt has a reason.
Next stage: `candidate_merged`.

# candidate_merged

Goal: continue only with the selected implementation on the child branch.
Allowed: verify selected candidate state, inspect selected diff, prepare refactor notes.
Required tools: `planner_transition_work_item` to `refactor` or `verification`.
Forbidden: refactoring rejected branches, resurrecting rejected candidates, changing tests to fit the implementation.
Exit condition: selected implementation is present on the child branch and rejected branches are no longer active.
Next stage: `refactor` or `verification`.

# work_item_commit

Goal: create the final planner-controlled work item commit.
Allowed: run final focused verification, inspect status, prepare a concise commit message.
Required tools: `planner_finish_work_item` with `stageAll: true` unless a narrower staged set is intentionally needed.
Forbidden: direct shell git commit, commit before tests pass, commit while memory refresh is required.
Exit condition: planner commit succeeds and state records the new commit.
Next stage: `signature_refresh`.

# signature_refresh

Goal: synchronize compressed memory with changed files after the commit.
Allowed: read dirty files, update file entries, update symbol signatures, update relations, verify entries, clear dirty flags.
Required tools: `planner_memory_get_dirty`, `planner_memory_upsert_files`, `planner_memory_upsert_symbols`, `planner_memory_upsert_relations`, verification tools, `planner_memory_clear_dirty`.
Forbidden: production edits, test edits, broad rediscovery, clearing dirty flags before memory is accurate.
Exit condition: all dirty files have accurate memory entries and dirty state is empty.
Next stage: `work_item_compact_required`.

# work_item_compact_required

Goal: compact after one atomic work item.
Allowed: request planner-controlled compact only.
Required tools: `planner_request_work_item_compact`, then after resume `planner_complete_work_item_compact`.
Forbidden: implementation, tests, memory edits unless recovery explicitly requires them.
Exit condition: compact is requested, completed, and the post-compact resume has been consumed.
Next stage: `completed`.

# completed

Goal: keep the completed item immutable.
Allowed: read artifacts, summarize result, select the next item from the active plan.
Required tools: `planner_next_step` before choosing the next action.
Forbidden: editing this item unless an explicit later recovery/reopen stage allows it.

# blocked

Goal: preserve evidence and stop unsafe work.
Allowed: explain the blocker, record exact evidence, ask the user for a recovery choice.
Required tools: recovery tools only when the user or planner state allows them.
Forbidden: guessing, bypassing git/memory/stage guards.

# failed

Goal: record a failed attempt or failed work item.
Allowed: document failure evidence and recommended next action.
Forbidden: hiding failed verification, continuing implementation without a new stage transition.

# skipped

Goal: record why the work item was skipped.
Allowed: document reason and dependency.
Forbidden: silently dropping planned work.

# details

Per-task engineering standard:
- Before code, state what the code does in one sentence.
- Define arguments, return type, edge cases, and integration points.
- TDD is mandatory: no production implementation starts before a focused failing test, mock test, or contract test exists.
- Then implement the smallest production change that makes the test pass.
- Verify with focused tests or checks before every stage transition.
- Keep modules portable: exported types, explicit config arguments, no hardcoded paths or keys.
- Ask a question instead of guessing unclear requirements.

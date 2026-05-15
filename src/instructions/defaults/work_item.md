# pending

The work item exists but is not ready. Do not implement it yet.

# ready

Prepare to start exactly one atomic work item. Confirm scope, expected files, tests, and dependencies.

# active

Load only the context needed for the active work item. Do not drift into unrelated files or tasks.

# tdd_prepare

Write the TDD plan for this work item. Describe behavior, inputs, outputs, edge cases, failure modes, and verification commands. Do not implement production code.

# tdd_write_tests

Write or update tests first. Production implementation is still forbidden.

# tdd_tests_commit

Prepare the test-only checkpoint. Ensure the child branch is cleanly ready for experiment branches.

# experiments_running

Implement isolated experiment attempts. Each attempt must have its own branch, summary, changed files, verification result, and score.

# candidate_selection

Compare experiment attempts numerically and by engineering risk. Select exactly one candidate and explain why rejected attempts are worse.

# candidate_merged

Use the selected candidate on the child branch. Do not refactor rejected branches.

# work_item_commit

Prepare the planner-controlled work item commit. Do not commit directly through shell.

# signature_refresh

Refresh compressed memory for dirty files only. Update file, symbol, and relation records, verify evidence, then clear dirty entries.

# work_item_compact_required

Normal work is blocked until work item compaction is requested.

# completed

The work item is complete. Do not edit it unless a later stage reopens it.

# blocked

Explain the blocker and required recovery action.

# failed

Record the failure, evidence, and recommended next action.

# skipped

Record why the work item was skipped.

# details

Per-task engineering standard:
- Before code, state what the code does in one sentence.
- Define arguments, return type, edge cases, and integration points.
- Then implement the smallest change.
- Verify with focused tests or checks.
- Keep modules portable: exported types, explicit config arguments, no hardcoded paths or keys.
- Ask a question instead of guessing unclear requirements.

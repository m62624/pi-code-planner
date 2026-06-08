# finalize

## Purpose

Verify the complete plan branch as one integrated result, write a durable user-facing summary, compact the final context, and enter the explicit acceptance stage.

## Strict Step Order

1. `verify_plan_branch`
	- Inspect planner git state and confirm that all required tasks were merged.
	- Run project-level checks defined by project instructions and task evidence from the worktree path reported by `planner_status`.
	- Record failures, residual risks, and any checks that cannot run locally.
2. `doubt_review`
	- Before asking for user acceptance, deliberately doubt the completed result.
	- Reread `goal.md`, `plan.md`, task artifacts, `verify.md`, and the final worktree diff.
	- Check whether tests may be proving the wrong behavior, whether required cleanup/deletion/recovery paths are actually implemented, and whether the implementation violates any explicit non-goal or storage/API constraint.
	- If a plausible bug or missing requirement exists, write a `## Doubt Review` section to `verify.md` and `decisions.md`, then return to `planning/read_context` for revision tasks. Do not patch ad hoc in finalize.
	- If no actionable concern remains, write a short `## Doubt Review` pass note to `verify.md`.
3. `write_final_summary`
	- Write `final_summary.md`.
	- Include completed scope, changed files, checks, risks, output branch expectations, and unresolved limitations.
4. `compact_finalize`
	- Request planner-controlled compact preserving summary, verification, branch state, and risks.
5. `enter_done`
	- Advance to `done/present_result`.

## Restrictions

- Do not introduce new production behavior during finalize.
- Do not run tests, builds, linters, formatters, or project-specific checks from the original checkout. Use the planner worktree as shell cwd.
- Do not cleanup the worktree or plan files.
- Do not export the plan result before explicit user acceptance.
- Do not use raw git.
- If checks reveal missing implementation, record the issue and return through the controlled planning flow instead of patching ad hoc.
- During `doubt_review`, assume there may still be bugs even if tests pass. Passing checks are evidence, not acceptance.

## Exit Condition

Finalize is complete only when the integrated plan branch is checked, `final_summary.md` exists, final compact finishes, and state enters `done/present_result`.

## manual-compact

Preserve `final_summary.md`, project-level verification results, changed-file summary, branch state, known risks, and unresolved limitations. After compaction, call `planner_status`, read the final summary and verify artifacts, then enter done flow.

## auto-compact

Call `planner_status` immediately. Restore the exact finalize step and reread `final_summary.md` if it already exists. Do not export or cleanup until explicit user acceptance is recorded.

## Finalization & Verification Diagnostics

### 1. Pre-Merge Verification Failures
- **Integration Test Regressions**: If final tests fail on the plan branch, identify if the issue is a merge conflict regression.
- **Clean Diff Verification**: Run code inspection to ensure no temporary debug lines, print statements, or scratch files are committed.
- **Branch Synchronization**: Verify that the plan branch is fully up-to-date with the main base branch.

### 2. Resolution Flow
1. Run lint and format checks before finalizing.
2. If integration tests fail, rollback the merge, fix the bug in the task branch, and try merging again.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

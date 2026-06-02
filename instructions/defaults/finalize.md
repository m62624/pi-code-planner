# finalize

## Purpose

Verify the complete plan branch as one integrated result, write a durable user-facing summary, compact the final context, and enter the explicit acceptance stage.

## Strict Step Order

1. `verify_plan_branch`
   - Inspect planner git state and confirm that all required tasks were merged.
   - Run project-level checks defined by project instructions and task evidence from the worktree path reported by `planner_status`.
   - Record failures, residual risks, and any checks that cannot run locally.
2. `write_final_summary`
   - Write `final_summary.md`.
   - Include completed scope, changed files, checks, risks, output branch expectations, and unresolved limitations.
3. `compact_finalize`
   - Request planner-controlled compact preserving summary, verification, branch state, and risks.
4. `enter_done`
   - Advance to `done/present_result`.

## Restrictions

- Do not introduce new production behavior during finalize.
- Do not run tests, builds, linters, formatters, or project-specific checks from the original checkout. Use the planner worktree as shell cwd.
- Do not cleanup the worktree or plan files.
- Do not export the plan result before explicit user acceptance.
- Do not use raw git.
- If checks reveal missing implementation, record the issue and return through the controlled planning flow instead of patching ad hoc.

## Exit Condition

Finalize is complete only when the integrated plan branch is checked, `final_summary.md` exists, final compact finishes, and state enters `done/present_result`.

## manual-compact

Preserve `final_summary.md`, project-level verification results, changed-file summary, branch state, known risks, and unresolved limitations. After compaction, call `planner_status`, read the final summary and verify artifacts, then enter done flow.

## auto-compact

Call `planner_status` immediately. Restore the exact finalize step and reread `final_summary.md` if it already exists. Do not export or cleanup until explicit user acceptance is recorded.

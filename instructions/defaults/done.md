# done

## Purpose

Present the verified plan result, wait for an explicit user decision, then either return to planning for requested changes or export one clean output branch and remove temporary planner state.

## Strict Step Order

1. `present_result`
   - Read `final_summary.md` and present scope, checks, risks, plan branch, worktree path, and output options.
2. `await_user_acceptance`
   - Ask the user to accept the result or request changes.
   - Never decide on behalf of the user.
3. `handle_change_request`
   - Record user feedback in durable artifacts.
   - Return to `planning/read_memory` in the same plan worktree and branch.
4. `prepare_output_branch`
   - After explicit acceptance, use planner git wrappers to prepare the output branch.
5. `merge_or_export_result`
   - Export the plan branch result through the state-controlled wrapper.
6. `cleanup_worktree`
   - Remove the temporary worktree and safe-to-delete managed child branches.
7. `mark_done`
   - Clear active plan state and mark the result complete.
8. `cleanup_plan_files`
   - Remove completed plan artifacts only after `mark_done`.

## Acceptance Rules

- No production edits are allowed in done.
- Change requests preserve the worktree and return to planning.
- Cleanup requires explicit acceptance.
- The protected plan branch is never deleted by managed child cleanup.
- After successful cleanup, the user keeps one output branch in the original repository and decides whether to merge, rebase, or delete it.
- Raw git is forbidden.

## Change Request Reload

When returning to `planning/read_memory`, reread full `plan.md`, `decisions.md`, user feedback, project patterns, and bounded memory. Rebuild tasks only as needed for the requested change.

## auto-compact

Call `planner_status` immediately. Reread `final_summary.md` and the exact persisted decision state. Do not infer acceptance from previous chat context. Only explicit user acceptance authorizes export and cleanup.

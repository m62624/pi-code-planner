# done

## Purpose

Present the verified plan result, wait for an explicit user decision, then either return to planning for requested changes or export one clean output branch and remove temporary planner state.

## Strict Step Order

1. `present_result`
   - Read `final_summary.md` and present scope, checks, risks, plan branch, worktree path, and output options.
   - After presenting the result, call `planner_finish_step` immediately to enter `await_user_acceptance`.
2. `await_user_acceptance`
   - Ask the user to accept the result or request changes.
   - Never decide on behalf of the user.
   - If the user accepts, ask the user to run `/planner-accept`.
   - `/planner-accept` atomically performs the remaining export, cleanup, and Pi session handoff. Do not try to reproduce that cleanup through model tools.
3. `handle_change_request`
   - Record user feedback in durable artifacts.
   - Return to `planning/read_memory` in the same plan worktree and branch.
4. `prepare_output_branch`
   - Internal `/planner-accept` phase: prepare the output branch in the original repository.
5. `merge_or_export_result`
   - Internal `/planner-accept` phase: export the plan branch result.
6. `cleanup_worktree`
   - Internal `/planner-accept` phase: remove the temporary worktree and safe-to-delete managed child branches.
7. `mark_done`
   - Internal `/planner-accept` phase: clear active plan state and mark the result complete.
8. `cleanup_plan_files`
   - Internal `/planner-accept` phase: remove completed plan artifacts only after `mark_done`.

## Acceptance Rules

- `/planner-accept` is an explicit user acceptance command. It may safely finalize directly after `present_result` or during `await_user_acceptance` when all runtime gates are clean.
- No production edits are allowed in done.
- Change requests preserve the worktree and return to planning.
- Cleanup requires explicit acceptance.
- During normal work the protected plan branch is never deleted by managed child cleanup.
- After successful `/planner-accept`, the temporary plan branch is removed because its result is already exported.
- The user keeps exactly one output branch in the original repository and decides whether to merge, rebase, or delete it.
- If the original Pi JSONL session exists, `/planner-accept` returns to it and removes the completed worktree chat.
- If the original Pi JSONL session is missing, `/planner-accept` warns the user, creates a replacement project-root session, and asks whether to remove the completed worktree chat.
- Raw git is forbidden.

## Change Request Reload

When returning to `planning/read_memory`, reread full `plan.md`, `decisions.md`, user feedback, project patterns, and bounded memory. Rebuild tasks only as needed for the requested change.

## auto-compact

Call `planner_status` immediately. Reread `final_summary.md` and the exact persisted decision state. Do not infer acceptance from previous chat context. Only explicit user acceptance authorizes export and cleanup.

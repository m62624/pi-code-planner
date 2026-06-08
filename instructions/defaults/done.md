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
   - If the user accepts, ask the user to run `/planner-finish`.
   - If the user writes what is wrong or requests more work instead of running `/planner-finish`, treat that as a change request.
   - For a change request, call `planner_finish_step` with target `done/handle_change_request`.
   - `/planner-finish` atomically performs the remaining export, cleanup, and Pi session handoff. Do not try to reproduce that cleanup through model tools.
3. `handle_change_request`
	- Record user feedback in durable artifacts.
	- Append a `## Change Request` section to `decisions.md` with the user's exact requested corrections.
	- Append a short `## Change Request Replan` note near the start of `plan.md`: the previous implementation is complete, but the user requested follow-up changes. Include `### Completed Work` and `### Remaining Work` subsections. Do not rewrite the old plan wholesale or delete the previous plan history.
	- Append a `## Post-Implementation Snapshot` section to `discovery.md`: summarize what was implemented, current relevant files/branches, known gaps, and why the user requested another pass. Include `### Completed Work` and `### Remaining Work` subsections.
	- Treat existing task artifacts as completed history. The follow-up planning pass may create new revision tasks for the remaining work, but must not reopen completed task IDs.
	- Return to `planning/read_context` in the same plan worktree and branch.
4. `prepare_output_branch`
   - Internal `/planner-finish` phase: prepare the output branch in the original repository.
5. `merge_or_export_result`
   - Internal `/planner-finish` phase: export the plan branch result.
6. `cleanup_worktree`
   - Internal `/planner-finish` phase: remove the temporary worktree and safe-to-delete managed child branches.
7. `mark_done`
   - Internal `/planner-finish` phase: clear active plan state and mark the result complete.
8. `cleanup_plan_files`
   - Internal `/planner-finish` phase: remove completed plan artifacts only after `mark_done`.

## Acceptance Rules

- `/planner-finish` is an explicit user acceptance command. It may safely finalize directly after `present_result` or during `await_user_acceptance` when all runtime gates are clean.
- No production edits are allowed in done.
- Change requests preserve the worktree and return to planning.
- Cleanup requires explicit acceptance.
- During normal work the protected plan branch is never deleted by managed child cleanup.
- After successful `/planner-finish`, the temporary plan branch is removed because its result is already exported.
- The user keeps exactly one output branch in the original repository and decides whether to merge, rebase, or delete it.
- If the original Pi JSONL session exists, `/planner-finish` returns to it and removes the completed worktree chat.
- If the original Pi JSONL session is missing, `/planner-finish` warns the user, creates a replacement project-root session, and asks whether to remove the completed worktree chat.
- Raw git is forbidden.

## Change Request Reload

When returning to `planning/read_context`, reread full `plan.md`, `decisions.md`, user feedback, and `discovery.md`. Treat the previous implementation as current project context, not as a blank project. Preserve completed work, revise the plan only where the change request requires it, then continue toward execution. Existing completed task artifacts remain as audit history. Rebuild tasks only as needed for the requested change. Do not repeat tasks listed under `Completed Work`; create new revision task IDs only for work listed under `Remaining Work`.

## auto-compact

Call `planner_status` immediately. Reread `final_summary.md` and the exact persisted decision state. Do not infer acceptance from previous chat context. Only explicit user acceptance authorizes export and cleanup.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

# init

## Purpose

Initialize planner control before any project discovery or implementation work begins.

The normal entry point is `planner_create_plan` or `/planner-create`. The extension performs init as an internal atomic bootstrap and should leave the persisted position at `intake/draft_goal`. If `planner_status` exposes an init step, follow the exact step rule and do not skip ahead.

## Required Discipline

1. Resolve the opened project root and stable project id.
2. Check whether git is available through planner wrappers.
3. Initialize git only when the repository does not exist and the controlled flow allows it.
4. Prepare project storage, settings, instruction files, plan artifacts, and memory files.
5. Resolve the worktree location from effective settings. Do not invent a path.
6. Create exactly one dedicated worktree for the whole plan.
7. Enter `intake/draft_goal`.

## Restrictions

- Do not read source code for task understanding during init.
- Do not edit project files.
- Do not create tasks, task branches, experiment branches, or commits.
- Do not run raw git through shell.
- Do not edit `project.json`, `plan.json`, `state.json`, checkpoint files, or worktree indexes directly.
- If bootstrap state is inconsistent, call `planner_status` and use recovery guidance.

## Exit Condition

Init is complete only when the plan record exists, the plan worktree exists, the active branch is recorded, and state points to `intake/draft_goal`.

## auto-compact

An auto-compact during init does not authorize progress. Call `planner_status`, reload the exact persisted init step, and continue only with the wrapper reported by status. Do not inspect source until intake is approved and state explicitly says `discovery/read_project`.

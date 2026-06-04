# init

## Purpose

Initialize planner control before any project discovery or implementation work begins.

The normal entry point is `planner_create_plan` or `/planner-create`. The extension performs init as an internal atomic bootstrap and should leave the persisted position at `intake/draft_goal`. If `planner_status` exposes an init step, follow the exact step rule and do not skip ahead.

## Required Discipline

1. Resolve the opened project root and stable project id.
2. Check whether git is available through planner wrappers.
3. Initialize git only when the repository does not exist and the controlled flow allows it.
4. Prepare project storage, settings, instruction files, and plan artifacts.
5. Resolve the worktree location from effective settings. Do not invent a path.
6. Create exactly one dedicated worktree for the whole plan.
   - For a project-local worktree, the extension writes a repository-local exclude rule for the original checkout.
   - If the plan branch `.gitignore` rule is created or appended, the extension commits it immediately on the plan branch before normal planner work begins.
7. Enter `intake/draft_goal`.

## Restrictions

- Do not read source code for task understanding during init.
- Do not edit project files.
- Do not create tasks, task branches, or commits.
- Do not run raw git through shell.
- Do not edit `project.json`, `plan.json`, `state.json`, or worktree indexes directly.
- If bootstrap state is inconsistent, call `planner_status` and use recovery guidance.

## Exit Condition

Init is complete only when the plan record exists, the plan worktree exists, the active branch is recorded, and state points to `intake/draft_goal`.

## auto-compact

An auto-compact during init does not authorize progress. Call `planner_status`, reload the exact persisted init step, and continue only with the wrapper reported by status. Do not inspect source until intake is approved and state explicitly says `discovery/scan_project_structure`.

## Initialization & Bootstrapping Diagnostics

### 1. Environment & Setup Failures
- **Worktree Conflicts**: If the worktree creation fails, check if a directory with the same name already exists. Ensure that your current git repository is clean and has no locked index files (`.git/index.lock`).
- **Workspace Resolution**: Verify that the Cwd is within the workspace root. Never initialize a plan in `/tmp` or system directories.
- **State Inconsistency**: If the plan files exist but the active plan status is not detected, use recovery tools immediately instead of manually recreating files.

### 2. Troubleshooting Steps
1. Call `planner_status` to see if the project storage paths are correctly resolved.
2. Check for locked files or missing file permissions.
3. If git is uninitialized in the project root, verify if you should call `planner_git_init`.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

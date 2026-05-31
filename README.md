This repository is an experiment built with Pi Code and Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf for local coding work. The project may contain non-professional design choices, rough edges, or mistakes. Use it at your own risk.

# pi-code-planner

`pi-code-planner` is an experimental Pi Code extension for long-running coding work with local language models.

The project is designed around a practical constraint: a smaller local model can often write focused code well, but it may lose architectural context, skip validation, repeat work after compaction, or confuse git state during a long session. This extension adds a disk-first workflow that narrows each action, persists progress, and guides the model through one explicit step at a time.

The extension is primarily a helper for local models themselves. It does not try to replace the model's reasoning. It provides a harness around that reasoning:

- one persistent plan state per project plan
- one isolated git worktree per active plan
- explicit discovery and planning before implementation
- strict tests-first task execution
- sequential experiment branches for alternative implementations
- compressed project memory with file hashes, signatures, relations, and effects
- compact boundaries that restore context through persisted artifacts
- planner-controlled git wrappers and recovery checks
- `planner_status` as the model-facing navigation tool

This is an experimental personal project, not a production-ready automation system.

## Why This Exists

Large hosted models can often hold broad project context and decompose tasks on their own. Smaller local models benefit from a stricter environment:

```text
understand project
  -> persist compressed memory
  -> create one bounded plan
  -> select one atomic task
  -> write tests first
  -> try one or more implementation candidates
  -> select the best candidate
  -> refactor and verify
  -> merge into the plan branch
  -> compact context
  -> continue with the next task
```

The extension uses files and git as durable memory. Chat history is useful, but it is not the source of truth.

## Current Status

The TypeScript layers, mock tests, state machine, tools, instruction sync, and Pi registrations are implemented. The repository still needs broader live beta testing with real Pi sessions and local models.

Known limitation: recovery currently provides inspection and non-destructive resume. Destructive recovery actions such as reset, forced checkout, or discarding dirty changes are intentionally not exposed as model tools.

## Requirements

- Pi Code
- Node.js
- Git
- a project directory where git can be initialized or used

The extension is model-agnostic, but it is specifically designed for local-model workflows.

## Development Setup

Install dependencies:

```bash
npm install
```

Run Pi with the local extension:

```bash
pi -e ./src/index.ts
```

Pi packages can also be loaded through Pi's normal package installation flow after the repository is published or shared:

```bash
pi install git:<repository-url>
```

## Start A Plan

Open Pi in the project you want to modify and run:

```text
/planner-create Implement a focused project change
```

Optional explicit plan id:

```text
/planner-create --id focused-change Implement a focused project change
```

If no id is provided, the extension generates a deterministic slug from the title and adds a numeric suffix when needed.

Plan creation performs the bootstrap automatically:

```text
resolve project
  -> check git
  -> prepare planner storage
  -> create plan branch
  -> create plan worktree
  -> persist state.json
  -> switch Pi into a worktree session
  -> start discovery/read_project
```

After switching sessions, the model should call:

```text
planner_status
```

## User Commands

These are Pi slash commands for the user. They are not model tools.

| Command | Purpose |
| --- | --- |
| `/planner-create [--id <plan-id>] <title>` | Create a plan, worktree, state files, and worktree Pi session. |
| `/planner-switch [<plan-id>]` | Switch to another plan in the current project. Without an id, open the TUI picker. |
| `/planner-rename [--id <plan-id>] <new-title>` | Rename a human-readable plan title without changing ids, branches, or paths. |
| `/planner-delete [<plan-id>]` | Delete a selected inactive plan after confirmation. Without an id, open the TUI picker. |
| `/planner-delete --force-active <plan-id>` | Explicit escape hatch: remove an active plan, its worktree, related planner files, and managed child branches. |

## Core Model Rule

When a plan is active, the model should call `planner_status` whenever it is unsure what to do next and after every planner tool result, compact boundary, recovery action, or user decision.

`planner_status` returns:

- current `stage`, `step`, `stepStatus`, and `nextStep`
- active plan, task, experiment, branch, and worktree
- git and memory consistency state
- the next required planner action
- currently allowed planner wrapper tools
- currently allowed state transitions
- exact artifact paths
- the relevant instruction bundle for the current stage and step
- memory-first reminders

The model should not infer the next workflow transition from chat history.

## Lifecycle Overview

```text
init
  -> discovery
  -> planning
  -> execution
      -> task
          -> TDD plan
          -> failing test
          -> experiment A
          -> compact
          -> experiment B
          -> compact
          -> select best candidate
          -> merge into task
          -> refactor
          -> verify
          -> merge into plan
          -> compact task
  -> finalize
  -> done

recovery may interrupt normal flow when persisted state and git reality disagree.
```

## Stage And Step Reference

The state machine contains 56 explicit steps. Normal flow is ordered. A completed step must advance before the next one starts. Recovery is the only stage that can resume into a validated non-recovery position.

### `init`

Bootstrap is normally handled automatically by `/planner-create`.

| Step | Purpose |
| --- | --- |
| `check_project` | Resolve the opened project root and stable project id. |
| `check_git` | Detect the git repository or initialize it through planner control. |
| `prepare_storage` | Create or load project-level planner storage. |
| `choose_worktree_location` | Resolve project-local or custom worktree settings. |
| `create_plan_record` | Create plan records, state, markdown artifacts, and memory files. |
| `create_plan_worktree` | Create one dedicated worktree for the entire plan. |
| `enter_discovery` | Persist the transition into `discovery/read_project`. |

### `discovery`

Discovery is the broad project-read stage. It builds compressed memory before implementation.

| Step | Purpose |
| --- | --- |
| `read_project` | Read the project structure, source, tests, manifests, and relevant documentation. |
| `write_project_patterns` | Persist architecture, dependency, testing, and convention notes. |
| `write_file_index` | Index relevant files with hashes and concise summaries. |
| `write_symbols` | Record signatures, anchors, visibility, summaries, and effects. |
| `write_relations` | Record evidence-backed relationships between files and symbols. |
| `write_questions` | Persist focused questions, uncertainty, and assumptions. |
| `verify_memory` | Verify memory freshness and sync the initial checkpoint. |
| `compact_discovery` | Compact the broad discovery context. |
| `enter_planning` | Persist the transition into `planning/read_memory`. |

### `planning`

Planning converts verified project memory into ordered atomic tasks.

| Step | Purpose |
| --- | --- |
| `read_memory` | Reconstruct project context from compressed artifacts and bounded memory retrieval. |
| `draft_plan` | Write the implementation strategy, constraints, risks, and checks. |
| `split_tasks` | Decompose the plan into small ordered tasks. |
| `write_task_files` | Write a `task.json` and `task.md` for each task. |
| `verify_plan` | Confirm that tasks are bounded, ordered, testable, and complete. |
| `compact_planning` | Compact the plan and task list before execution. |
| `enter_execution` | Persist the transition into `execution/prepare_task`. |

### `execution`

Execution processes exactly one task at a time. Experiments are sequential alternative implementations, not parallel agents.

| Step | Purpose |
| --- | --- |
| `prepare_task` | Select one pending task and create or switch its task branch. |
| `write_tdd_plan` | Write test strategy, mocks, fixtures, edge cases, and expected failing signal. |
| `write_tests` | Add failing, mock, or contract tests before implementation. |
| `run_failing_tests` | Prove that tests detect the missing behavior. |
| `start_experiments` | Create one experiment branch for one distinct attempt. |
| `run_experiment` | Implement one candidate, run checks, commit, and refresh memory. |
| `summarize_experiment` | Persist approach, checks, strengths, weaknesses, risks, and comparison evidence. |
| `compact_experiment` | Compact the completed candidate context. |
| `select_experiment` | Continue with another distinct attempt or select the best candidate. |
| `merge_best_experiment` | Merge the selected candidate into the task branch. |
| `refactor_task` | Improve the selected result without changing behavior. |
| `run_final_tests` | Run focused and broader task-level verification. |
| `merge_task_to_plan` | Merge the verified task branch into the plan branch. |
| `compact_task` | Compact the completed atomic task. |
| `select_next_task` | Start the next task or transition into final verification. |

### `finalize`

Finalize verifies the integrated plan branch before asking the user to accept the result.

| Step | Purpose |
| --- | --- |
| `verify_plan_branch` | Confirm merged tasks and run project-level checks. |
| `write_final_summary` | Write completed scope, changed files, checks, risks, and limitations. |
| `compact_finalize` | Compact final context before presenting the result. |
| `enter_done` | Persist the transition into `done/present_result`. |

### `done`

Done is an explicit user-decision stage, not just a terminal marker.

| Step | Purpose |
| --- | --- |
| `present_result` | Present the verified result and output options. |
| `await_user_acceptance` | Wait for explicit acceptance or a change request. |
| `handle_change_request` | Record feedback and return to planning in the same worktree. |
| `prepare_output_branch` | Prepare the output branch after acceptance. |
| `merge_or_export_result` | Export the plan branch result through planner-controlled git. |
| `cleanup_worktree` | Remove the temporary worktree and safe-to-delete child branches. |
| `mark_done` | Clear active plan state and mark completion. |
| `cleanup_plan_files` | Remove completed plan artifacts after cleanup. |

### `recovery`

Recovery handles mismatches between persisted planner state and actual git/worktree state.

| Step | Purpose |
| --- | --- |
| `read_state` | Load expected planner state. |
| `inspect_git` | Inspect actual branch, HEAD, dirty files, and conflicts. |
| `compare_expected_actual` | Compare persisted state with repository reality. |
| `classify_recovery` | Classify the mismatch and safe next options. |
| `ask_user_if_destructive` | Ask before any destructive repair path. |
| `repair_or_resume` | Resume only after consistency is restored or explicitly accepted. |

## TDD And Experiments

Every execution task follows tests-first development:

```text
task branch
  -> write TDD plan
  -> write failing/mock/contract tests
  -> prove failing signal
  -> create experiment branch
  -> implement one candidate
  -> verify and summarize
  -> compact
  -> optionally repeat with another candidate
  -> select best candidate
  -> merge candidate into task
  -> refactor on task branch
  -> run final checks
  -> merge task into plan
```

The model can create multiple candidate experiments when different approaches are useful. It selects the best experiment id, but it does not invent merge targets. Merge targets are derived from persisted state.

## Compact Boundaries

Compaction is intentional and artifact-driven. The extension does not compact after every technical action.

| Boundary | Reason |
| --- | --- |
| `discovery/compact_discovery` | Preserve project understanding and compressed memory. |
| `planning/compact_planning` | Preserve the complete plan and ordered tasks. |
| `execution/compact_experiment` | Preserve one candidate summary before another attempt or selection. |
| `execution/compact_task` | Preserve one merged atomic task before selecting the next task. |
| `finalize/compact_finalize` | Preserve final verification before user acceptance. |

Pi auto-compaction is also tracked. After planned or automatic compaction, the extension sends a system-style continuation message that instructs the model to call `planner_status` and reload exact persisted artifacts.

## Project Memory

The memory layer is a compressed project index for context-limited models. It avoids repeatedly loading the entire repository.

Memory stores:

- file paths, hashes, languages, kinds, statuses, and summaries
- symbol signatures and anchors
- symbol visibility and verification status
- relations such as calls, tests, depends-on, configures, reads, and writes
- effects that may not be visible in a signature

Effects matter because a function can keep the same signature while starting to read environment variables, mutate global state, use filesystem or network I/O, depend on time or randomness, or call another side-effectful function.

Memory is updated after planner-controlled commits and merges:

```text
git write
  -> detect new HEAD
  -> build file-hash snapshot
  -> mark stale files and related symbols
  -> update affected memory entries
  -> verify freshness
  -> sync checkpoint
  -> continue workflow
```

The model should read bounded memory first and reread source only when memory is missing, stale, insufficient, or requires verification.

## Git Model

Each plan owns one worktree. Tasks, experiments, and refactors are branches inside that worktree.

```text
base branch
  -> plan/<plan-id>
    -> task/<plan-id>/<task-id>
      -> experiment/<plan-id>/<task-id>/<attempt-id>
      -> refactor/<plan-id>/<task-id>
  -> output/<plan-id>
```

Branch cleanup rules:

- unselected experiment branches are removed after candidate selection and merge
- the selected experiment branch is removed after merge into task
- the refactor branch is removed after merge into task
- the task branch is removed after merge into plan
- the protected plan branch is not removed by managed child cleanup
- worktree cleanup happens only after explicit user acceptance

When a planner plan is active, raw shell `git` commands are blocked. The model uses planner git wrapper tools instead. Non-git shell commands remain available.

## Built-In Pi Tool Guard

The extension intentionally keeps built-in tool guarding coarse-grained:

| Stage | Project `write/edit` |
| --- | --- |
| `init` | blocked |
| `discovery` | blocked |
| `planning` | blocked |
| `execution` | allowed |
| `finalize` | allowed |
| `done` | allowed |
| `recovery` | allowed |

Planner artifacts outside the project directory remain writable during discovery and planning.

The extension does not try to classify files as tests, production code, fixtures, configuration, or documentation. File roles differ across languages and projects. It also does not maintain an allowlist of shell commands. Shell safety can be handled by a separate approval extension.

## Storage Layout

Planner state is stored under the Pi agent directory:

```text
getAgentDir()/extensions/pi-code-planner/
  settings.json
  instructions/
    defaults/
    append/
  worktree-index/
    <worktree-hash>.json
  projects/
    <project-id>/
      project.json
      plans/
        <plan-id>/
          plan.json
          state.json
          plan.md
          discovery.md
          questions.md
          decisions.md
          memory/
            project_patterns.md
            files/index.jsonl
            symbols/index.jsonl
            relations/index.jsonl
          tasks/
            <task-id>/
              task.json
              task.md
              tdd.md
              tests.md
              implementation.md
              verify.md
              experiments/
                <attempt-id>/
                  experiment.json
                  summary.md
```

Important files:

| File | Purpose |
| --- | --- |
| `project.json` | Stable project identity, plan list, and active plan id. |
| `plan.json` | Structured task list and progress for one plan. |
| `state.json` | Crash-recoverable execution state for one plan. |
| `plan.md` | Human-readable plan context. |
| `memory/*` | Compressed project context and freshness checkpoint data. |

## Worktree Settings

Global settings:

```text
getAgentDir()/extensions/pi-code-planner/settings.json
```

Optional project override:

```text
<project-root>/.pi/pi-code-planner/settings.json
```

Default project-local worktree:

```json
{
  "worktree": {
    "mode": "project-local"
  }
}
```

Default path:

```text
<project-root>/.pi/pi-code-planner/worktrees/<plan-id>
```

Custom root:

```json
{
  "worktree": {
    "mode": "custom",
    "root": "/mnt/fast/pi-worktrees"
  }
}
```

Custom path:

```text
<root>/<project-id>/<plan-id>
```

When project-local worktrees are used, the extension adds this exact rule to `.gitignore` if needed:

```text
.pi/pi-code-planner/worktrees/
```

It does not ignore the entire `.pi/` directory.

## Instruction Customization

Default instruction markdown is bundled with the extension and synced into:

```text
getAgentDir()/extensions/pi-code-planner/instructions/defaults/
```

Do not edit installed defaults. They may be refreshed after an extension update.

Global append files:

```text
getAgentDir()/extensions/pi-code-planner/instructions/append/
```

Optional project-local append files:

```text
<project-root>/.pi/pi-code-planner/instructions/append/
```

Available instruction keys:

```text
init
discovery
planning
execution
finalize
done
recovery
tdd
experiment
refactor
memory
git
git-commit
```

Resolution order:

```text
default
  + project append, when present
  + otherwise global append, when present
```

Append files extend defaults. They do not replace them.

Project-local append files are useful for repository-specific requirements such as test commands, architecture conventions, mock strategy, commit style, or verification expectations.

## Model-Facing Tools

Most users do not need to call these manually. They are registered for the model and gated by runtime state.

### Navigation

- `planner_status`
- `planner_create_plan`

### Workflow Transitions

- `planner_start_step`
- `planner_complete_step`
- `planner_advance_step`
- `planner_fail_step`
- `planner_block_step`
- `planner_retry_step`
- `planner_request_compact`
- `planner_complete_compact`
- `planner_enter_recovery`
- `planner_resume_after_recovery`

### Memory

- `planner_memory_inspect`
- `planner_memory_apply_freshness`
- `planner_memory_write_batch`
- `planner_memory_verify`
- `planner_memory_sync_checkpoint`

### Git

- `planner_git_inspect`
- `planner_git_init`
- `planner_git_commit`
- `planner_git_create_task_branch`
- `planner_git_create_experiment_branch`
- `planner_git_select_experiment`
- `planner_git_merge_selected_experiment`
- `planner_git_create_refactor_branch`
- `planner_git_merge_refactor_to_task`
- `planner_git_merge_task_to_plan`
- `planner_git_export_plan_to_output`
- `planner_git_remove_plan_worktree`
- `planner_git_cleanup_managed_branches`

### Recovery

- `planner_recovery_inspect`
- `planner_recovery_resume`

## Recovery Behavior

Before public planner tool calls, the extension compares persisted state with actual git and worktree reality:

- worktree existence
- current branch
- `HEAD`
- dirty files
- conflicts
- checkpoint commit
- memory freshness

When state and reality disagree, normal workflow stops and recovery inspection becomes available.

The extension does not automatically reset, delete, force-checkout, or discard user work. Destructive recovery remains a user decision.

## Development

Run tests:

```bash
npm test
```

Run static checks:

```bash
npm run check
```

Build TypeScript:

```bash
npm run build
```

## Safety Notes

- Review the source before installing. Pi extensions execute code with the permissions of the Pi process.
- This project is experimental.
- Planner persistence reduces lost context but cannot make model output correct automatically.
- Git wrappers reduce accidental workflow drift but do not replace normal code review.
- Shell safety is outside this extension's scope. Use a separate approval extension or an isolated environment when needed.
- Keep backups of important repositories.

> ⚠️ This repository is an experiment built with Pi Code and Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf for local coding work. The project may contain non-professional design choices, rough edges, or mistakes. Use it at your own risk.

# pi-code-planner 🧭

`pi-code-planner` is an experimental [Pi Code](https://github.com/badlogic/pi-mono) extension for coding with local language models on consumer hardware.

Install it directly from GitHub:

```bash
pi install git:github.com/m62624/pi-code-planner
```

Then open Pi inside a Git project and run:

```text
/planner-create
```

Pi opens a multiline editor. Describe the outcome you want. The extension creates an isolated worktree, moves Pi into that worktree session, and starts a deterministic workflow around the model.

**Note:** If `Shift+Enter` does not insert a new line in the `/planner-create` editor, create `~/.pi/agent/keybindings.json` with the following content to bind `Ctrl+J` as the new line shortcut:
```json
{
  "tui.input.newLine": ["ctrl+j"]
}
```
After editing the file, run `/reload` in Pi to apply the changes.

## Why Pi? 🪶

Pi was chosen as the harness because it is intentionally small. It does not assume that every coding agent has cloud-scale context, many concurrent subagents, or a large infrastructure budget.

That matters for local models. On a single consumer machine, KV cache, RAM, VRAM, and prompt length are constrained. A local model may write focused code well but still lose project context after compaction, skip verification, repeat work, or confuse Git state during a long task. Running many subagents can make those limits worse.

`pi-code-planner` adds only the structure needed to help a local model stay oriented:

- one persisted state machine;
- one isolated Git worktree per plan;
- explicit discovery before implementation;
- concise discovery artifacts that survive compaction;
- tests-first task execution;
- controlled Git wrappers;
- recovery checks when persisted state and repository reality disagree;
- `planner_status` as the model-facing source of truth;
- dynamic model tool scope so a local model sees only the planner wrappers allowed at its exact persisted state.

This is not a guarantee of better output. The extension can also make results worse by adding overhead or constraining the model at the wrong time. It is an experiment in controlling a small stochastic coding model with deterministic code around it.

The extension was tested primarily with `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf`, but the workflow is model-agnostic.

## Basic Workflow 🔄

```text
user request
  -> normalize and approve goal
  -> inspect only relevant project files
  -> persist a concise discovery summary
  -> write an implementation plan
  -> split work into atomic tasks
  -> write tests first
  -> implement and compare candidates
  -> refactor and verify
  -> merge completed tasks into one plan branch
  -> ask the user to accept or request changes
  -> export one ordinary output commit
```

The chat is not the source of truth. Durable JSON and Markdown artifacts are. After compaction or recovery, the model calls `planner_status`, reloads the current position, and continues from persisted state.

Planner slash commands remain available to the user. Model-facing planner tools are narrower: with no active plan, only `planner_status` is added to the normal Pi tool set. With an active plan, the extension keeps normal Pi tools and exposes only the planner wrappers allowed by the current runtime gate, stage, step, and transition state.

## User Commands 🎛️

These are Pi slash commands for the user. The model has separate internal tools.

| Command | Purpose |
| --- | --- |
| `/planner-create` | Open a multiline request editor and create a new plan. |
| `/planner-create --id <plan-id>` | Create a plan with an explicit stable id. Without `--id`, a deterministic id is generated from the request. |
| `/planner-switch` | Open a TUI picker for plans in the current project. |
| `/planner-switch <plan-id>` | Activate a plan directly and resume its most recent non-empty worktree chat. |
| `/planner-rename` | Open a TUI picker, then rename the selected plan title. |
| `/planner-rename --id <plan-id> <title>` | Rename a plan directly without changing branches or paths. |
| `/planner-delete` | Open a TUI picker and delete a selected plan after confirmation. |
| `/planner-delete --force-active <plan-id>` | Explicit escape hatch: remove an active plan, its worktree, planner files, and managed child branches. |
| `/planner-accept` | Accept a completed plan, export `output/<plan-id>`, remove temporary planner state, and return Pi to the original project session. |

### Planner Switch And Pi Resume

Each plan has its own worktree, Git branch, state file, and Pi JSONL history.

Use `/planner-switch` for planner work. It updates the active plan, reopens the selected worktree session, restores the worktree CWD, and resumes its latest non-empty JSONL chat. It does not create an extra Git checkout: the worktree is already attached to the persisted planner branch.

Pi's built-in `/resume` starts in `Current Folder` scope. Press `Tab` to show `All` sessions, including worktree sessions. Directly resuming an inactive planner worktree through `/resume` is possible, but it does not update the planner's active plan record. Prefer `/planner-switch`.

## State Machine 🧱

The planner contains 57 explicit steps. Normal steps advance in order. Recovery is the only stage that can resume into a validated earlier position.

```text
init
  -> intake
  -> discovery
  -> planning
  -> execution
  -> finalize
  -> done

recovery may interrupt the normal path when Git, worktree, or state disagree.
```

### `init`

Normally completed automatically by `/planner-create`.

| Step | Purpose |
| --- | --- |
| `check_project` | Resolve the opened project root and stable project id. |
| `check_git` | Detect or initialize Git. |
| `prepare_storage` | Create planner storage. |
| `choose_worktree_location` | Resolve project-local or custom worktree settings. |
| `create_plan_record` | Create plan state and artifacts. |
| `create_plan_worktree` | Create the dedicated plan worktree. |
| `enter_intake` | Move into goal drafting. |

### `intake`

The model restates the user's request before reading source code.

| Step | Purpose |
| --- | --- |
| `draft_goal` | Rewrite the raw request into `goal.md` and propose a short user-facing plan title. |
| `await_goal_approval` | Show the goal and title, then wait for explicit user approval or revision. |

### `discovery`

The model becomes familiar with the project before implementation without indexing the whole repository.

| Step | Purpose |
| --- | --- |
| `scan_project_structure` | Inspect the project tree, read only useful files, and summarize findings in `discovery.md`. |
| `write_questions` | Ask focused questions after evidence is collected. |
| `compact_discovery` | Compact broad discovery context when enabled. |
| `enter_planning` | Move into plan construction. |

### `planning`

| Step | Purpose |
| --- | --- |
| `read_context` | Reconstruct context from `discovery.md`, questions, decisions, and task artifacts. |
| `draft_plan` | Write the implementation strategy, constraints, risks, and checks. |
| `split_tasks` | Divide the plan into ordered behavioral tasks. Tests stay inside each task's TDD cycle, never as standalone test items. |
| `write_task_files` | Call `planner_task_upsert`; the wrapper creates `task.json`, `task.md`, and empty TDD lifecycle artifacts. |
| `verify_plan` | Confirm that tasks are bounded, ordered, and testable. |
| `compact_planning` | Compact planning context when enabled. |
| `enter_execution` | Start the first task. |

### `execution`

Execution handles one task at a time. Experiments are sequential implementation candidates, not parallel subagents.

| Step | Purpose |
| --- | --- |
| `prepare_task` | Select one pending task and create its branch. |
| `write_tdd_plan` | Record test strategy, mocks, fixtures, edge cases, and expected failing signal. |
| `write_tests` | Write failing, mock, or contract tests before implementation. |
| `run_failing_tests` | Prove that the tests detect missing behavior. |
| `start_experiments` | Create one candidate branch. |
| `run_experiment` | Implement one candidate, run checks, and commit. |
| `summarize_experiment` | Record approach, diff, checks, risks, and tradeoffs. |
| `compact_experiment` | Compact candidate context when enabled. |
| `select_experiment` | Try another distinct candidate or select the best one. |
| `merge_best_experiment` | Merge the selected candidate into the task branch. |
| `refactor_task` | Challenge the selected code and simplify it without changing behavior. |
| `run_final_tests` | Run focused and broader task verification. |
| `merge_task_to_plan` | Merge the verified task into the plan branch. |
| `compact_task` | Compact the completed task when enabled. |
| `select_next_task` | Start the next task or enter final verification. |

### `finalize`

| Step | Purpose |
| --- | --- |
| `verify_plan_branch` | Run integrated project-level checks. |
| `write_final_summary` | Record scope, changed files, checks, risks, and limitations. |
| `compact_finalize` | Compact final context when enabled. |
| `enter_done` | Present the result to the user. |

### `done`

| Step | Purpose |
| --- | --- |
| `present_result` | Show the verified result. |
| `await_user_acceptance` | Wait for explicit acceptance or requested changes. |
| `handle_change_request` | Record feedback and return to planning in the same worktree. |
| `prepare_output_branch` | Internal `/planner-accept` phase. |
| `merge_or_export_result` | Export one squashed ordinary commit on `output/<plan-id>`. |
| `cleanup_worktree` | Remove temporary worktree and managed child branches. |
| `mark_done` | Clear active planner state. |
| `cleanup_plan_files` | Remove completed temporary artifacts. |

### `recovery`

Recovery is non-destructive by default.

| Step | Purpose |
| --- | --- |
| `read_state` | Load expected persisted state. |
| `inspect_git` | Inspect actual branch, HEAD, dirty files, and conflicts. |
| `compare_expected_actual` | Compare state with repository reality. |
| `classify_recovery` | Explain the mismatch and safe options. |
| `ask_user_if_destructive` | Ask before destructive repair. |
| `repair_or_resume` | Resume only after consistency is restored or explicitly accepted. |

## Git Model 🌿

Each plan owns one worktree. Tasks, experiments, and refactors are temporary branches inside it.

```text
base branch
  -> plan/<plan-id>
    -> task/<plan-id>/<task-id>
      -> experiment/<plan-id>/<task-id>/<attempt-id>
      -> refactor/<plan-id>/<task-id>
  -> output/<plan-id>
```

Temporary branches are removed after their result is merged. After `/planner-accept`, the user keeps one ordinary `output/<plan-id>` branch with one squashed result commit:

```bash
git show output/<plan-id>
```

While a plan is active, raw shell `git` is blocked for the model. Planner wrappers determine merge sources and targets from persisted state. The model chooses task ids and experiment ids, not arbitrary branch destinations.

Project commands such as tests, builds, linters, generators, and formatters should run from the worktree path reported by `planner_status`. Commands may still enter subdirectories inside that worktree when the project layout requires it.

## Project Context 🧠

Discovery is intentionally lightweight for context-limited local models:

The model inspects the project tree, reads only the files needed for the approved goal, and summarizes useful findings in `discovery.md`. The planner does not maintain a semantic index, embeddings model, vector database, or separate context database. After compact, the model reloads `discovery.md` and reads additional source files only when the current task needs more evidence.

## Storage Layout 📁

Planner state lives under the Pi agent directory:

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
          request.md
          goal.md
          plan.md
          discovery.md
          questions.md
          decisions.md
          final_summary.md
          tasks/
            <task-id>/
              task.json
              task.md
              tdd.md
              tests.md
              implementation.md
              refactor.md
              verify.md
              experiments/
                <attempt-id>/
                  experiment.json
                  summary.md
```

Key files:

| File | Purpose |
| --- | --- |
| `project.json` | Stable project identity, plan list, and active plan id. |
| `plan.json` | Structured task list for one plan. |
| `state.json` | Crash-recoverable stage, step, branch, worktree, and compact state. |
| `request.md` | Exact raw user request. |
| `goal.md` | Model-normalized goal approved before discovery. |
| `plan.md` | Human-readable implementation plan written after discovery. |
| `questions.md` | Evidence-based questions and explicit user answers. |
| `decisions.md` | Durable user decisions. |

## Settings And Overrides ⚙️

### Worktree Location

The default worktree location is project-local:

```text
<project-root>/.pi/pi-code-planner/worktrees/<plan-id>
```

The extension adds this exact rule when needed:

```text
.pi/pi-code-planner/worktrees/
```

It does not ignore the entire `.pi/` directory.

To move worktrees elsewhere, configure a root before running `/planner-create`.

Global settings apply to every project:

```text
getAgentDir()/extensions/pi-code-planner/settings.json
```

Project settings override global settings:

```text
<project-root>/.pi/pi-code-planner/settings.json
```

Example:

```json
{
  "worktree": {
    "mode": "custom",
    "root": "/mnt/fast/pi-worktrees"
  },
  "compact": {
    "stage": true,
    "task": false,
    "experiment": false
  }
}
```

The custom path becomes:

```text
<root>/<project-id>/<plan-id>
```

You do not need to know the generated plan id in advance. The extension appends both ids automatically.

Compact defaults are:

```json
{
  "stage": true,
  "task": false,
  "experiment": false
}
```

Skipped compact boundaries still advance through persisted state-machine steps, so recovery remains deterministic.

If compact generation times out on a slow local model, the boundary remains pending. Retry with `planner_request_compact`; for repeated timeouts, increase Pi's `HTTP idle timeout` in `/settings` to `5 min` or `disabled`.

### Instruction Append Files

Built-in Markdown instructions are synced into:

```text
getAgentDir()/extensions/pi-code-planner/instructions/defaults/
```

Do not edit synced defaults. Extension updates may overwrite them.

Add global instructions under:

```text
getAgentDir()/extensions/pi-code-planner/instructions/append/
```

Add project-specific instructions under:

```text
<project-root>/.pi/pi-code-planner/instructions/append/
```

Available filenames:

```text
init.md
intake.md
discovery.md
planning.md
execution.md
finalize.md
done.md
recovery.md
tdd.md
experiment.md
refactor.md
git.md
git-commit.md
```

Resolution is intentionally simple:

```text
built-in default
  + project append, when present
  + otherwise global append, when present
```

Append files extend defaults; they do not replace them. Project append files are useful for test commands, repository conventions, architecture notes, mock strategy, and commit style.

## Development 🛠️

Clone the repository when you want to modify the extension locally:

```bash
git clone https://github.com/m62624/pi-code-planner.git
cd pi-code-planner
npm install
npm run build
pi -e ./src/index.ts
```

Checks:

```bash
npm run build
npm run check
npm test
```

## Safety Notes ⚠️

- Review the source before installing. Pi extensions execute with the permissions of the Pi process.
- This is an experimental personal project.
- Persisted state reduces context loss but cannot make model output correct.
- Git wrappers reduce workflow drift but do not replace code review.
- Shell safety is outside this extension's scope. Use a separate approval extension or an isolated environment when needed.
- Keep backups of important repositories.

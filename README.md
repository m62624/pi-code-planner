> ⚠️ This repository is an experiment built with Pi Code and Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf for local coding work. It is maintained with local AI assistance and may contain non-professional design choices, rough edges, broken behavior, or mistakes. Use it at your own risk.

# pi-code-planner 🧭

`pi-code-planner` is an experimental [Pi Code](https://github.com/badlogic/pi-mono) extension for local coding models. It wraps a small deterministic state machine around a stochastic model so long coding tasks can survive compaction, Git branching, and user approval steps.

Install it directly from GitHub:

```bash
pi install git:github.com/m62624/pi-code-planner
```

Then open Pi inside a Git project and run:

```text
/planner-create
```

Pi opens a multiline editor. Describe the outcome you want. The extension creates an isolated worktree, moves Pi into that worktree session, and starts the planner workflow.

**Note:** If `Shift+Enter` does not insert a new line in the `/planner-create` editor, create `~/.pi/agent/keybindings.json` with the following content to bind `Ctrl+J` as the new line shortcut:
```json
{
  "tui.input.newLine": ["ctrl+j"]
}
```
After editing the file, run `/reload` in Pi to apply the changes.

## Why Pi? 🪶

Pi was chosen because it is intentionally small. It does not assume cloud-scale context, many subagents, or extra infrastructure. That matters on consumer hardware where KV cache, RAM, VRAM, and prompt length are constrained.

This extension adds the minimum structure a local model often lacks during long work: persisted state, one isolated Git worktree per plan, stage-specific instructions, controlled Git wrappers, recovery checks, and `planner_status` as the model-facing source of truth.

This is not a guarantee of better output. The extension can make results worse by adding overhead or constraining the model at the wrong time. It is an experiment, not a stable product.

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
  -> implement the current task
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
| `/planner-exit` | Return to the original project chat without finishing or deleting the active plan. |
| `/planner-resume` | Open a TUI picker for plans in the current project. |
| `/planner-resume <plan-id>` | Activate a plan directly and resume its most recent non-empty worktree chat. |
| `/planner-rename` | Open a TUI picker, then rename the selected plan title. |
| `/planner-rename --id <plan-id> <title>` | Rename a plan directly without changing branches or paths. |
| `/planner-delete` | Open a TUI picker and delete a selected plan after confirmation. |
| `/planner-delete <plan-id>` | Delete a plan directly after confirmation. Active plans are moved through a safe handoff session first. |
| `/planner-finish` | Finish a completed plan, export `output/<plan-id>`, remove temporary planner state, and return Pi to the original project session. |

### Planner Resume And Pi Resume

Each plan has its own worktree, Git branch, state file, and Pi JSONL history.

Use `/planner-resume` for planner work. It updates the active plan, reopens the selected worktree session, restores the worktree CWD, and resumes its latest non-empty JSONL chat. It does not create an extra Git checkout: the worktree is already attached to the persisted planner branch.

The resume picker shows the plan title first and the model-written short description on the next line.

Pi's built-in `/resume` starts in `Current Folder` scope. Press `Tab` to show `All` sessions, including worktree sessions. Directly resuming an inactive planner worktree through `/resume` is possible, but it does not update the planner's active plan record. Prefer `/planner-resume`.

## State Machine 🧱

The planner is a persisted workflow:

```text
init -> intake -> discovery -> planning -> execution -> finalize -> done
```

`recovery` can interrupt this path when Git, the worktree, or `state.json` disagree.

Key behavior:

- `intake`: the model restates the request and waits for approval before discovery.
- `discovery`: the model reads only useful project files and writes a concise `discovery.md`.
- `planning`: tasks are behavioral. Tests stay inside each task's TDD cycle.
- `execution`: each task goes through TDD, implementation, mandatory refactor review, final checks, and merge.
- `done`: the user accepts, requests changes, or runs `/planner-finish`.

## Git And Worktrees 🌿

Each plan owns one Git worktree and one protected plan branch:

```text
base -> plan/<plan-id> -> task/<plan-id>/<task-id> -> refactor/<plan-id>/<task-id> -> output/<plan-id>
```

Temporary task/refactor branches are removed after merge. `/planner-finish` exports one ordinary `output/<plan-id>` branch with a squashed result commit.

While a plan is active, the model must use planner Git wrappers. Raw shell `git` is blocked. Project commands such as tests, builds, linters, and generators should run from the worktree path reported by `planner_status`.

## Artifacts 📁

Planner state lives under:

```text
getAgentDir()/extensions/pi-code-planner/
```

Main files:

| File | Purpose |
| --- | --- |
| `project.json` | Project identity, plan list, active plan id. |
| `plan.json` | Structured plan and task list. |
| `state.json` | Crash-recoverable stage, step, branch, and worktree state. |
| `request.md` | Raw user request. |
| `goal.md` | Approved goal. |
| `discovery.md` | Concise project context. |
| `plan.md` | Implementation plan. |
| `questions.md` | Questions and user answers. |
| `tasks/<task-id>/task.md` | Task description. |
| `tasks/<task-id>/tdd.md` | TDD plan, test evidence, check results. |
| `tasks/<task-id>/refactor.md` | Refactor review and final verification notes. |

## Settings ⚙️

Default worktrees are project-local:

```text
<project-root>/.pi/pi-code-planner/worktrees/<plan-id>
```

The extension only ignores this path, not the whole `.pi/` directory.

Optional settings files:

```text
getAgentDir()/extensions/pi-code-planner/settings.json
<project-root>/.pi/pi-code-planner/settings.json
```

Example:

```json
{
  "worktree": { "mode": "custom", "root": "/mnt/fast/pi-worktrees" },
  "compact": { "stage": true, "task": false }
}
```

Instruction append files can be placed under:

```text
getAgentDir()/extensions/pi-code-planner/instructions/append/
<project-root>/.pi/pi-code-planner/instructions/append/
```

Use append files for project test commands, architecture notes, mock strategy, and commit style.

## Development 🛠️

```bash
git clone https://github.com/m62624/pi-code-planner.git
cd pi-code-planner
npm install
npm run build
pi -e ./src/index.ts
```

Checks:

```bash
npm run check
npm run build
npm test
```

## Safety ⚠️

- Pi extensions execute with the permissions of the Pi process.
- Persisted state reduces context loss but cannot make model output correct.
- Git wrappers reduce workflow drift but do not replace code review.
- Keep backups of important repositories.

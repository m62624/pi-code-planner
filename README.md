> ⚠️ This repository is an experiment built with Pi Code and Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf for local coding work. It is maintained with local AI assistance and may contain non-professional design choices, rough edges, broken behavior, or mistakes. Use it at your own risk.

# pi-code-planner 🧭

<p align="center">
  <img src="assets/icon.png" alt="pi-code-planner icon" width="180">
</p>

`pi-code-planner` is an experimental [Pi Code](https://github.com/badlogic/pi-mono) extension for local coding models. It wraps a small deterministic state machine around a stochastic model so long coding tasks can survive compaction, Git branching, and user approval steps.

Install the npm package after it is published:

```bash
pi install npm:pi-code-planner
```

Or install the development repository directly from GitHub:

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
  -> verify the whole plan branch
  -> doubt the result and prove/disprove possible errors
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

Stage behavior:

- `init`: validate the Git project, create planner storage, choose the worktree location, create the plan branch/worktree, then enter intake.
- `intake`: restate the request in `goal.md`, propose a title and short description, and wait for explicit user approval before discovery.
- `discovery`: inspect only useful project files, record `discovery.md`, ask evidence-based questions when needed, then compact before planning.
- `planning`: read persisted context, write `plan.md`, split behavioral tasks, create task artifacts, verify task order, then compact before execution.
- `execution`: for each task, prepare a task branch, write a TDD plan, write tests first, run the failing signal, implement, run structured refactor review, run final checks, merge the task, then select the next task.
- `finalize`: verify the integrated plan branch, run `doubt_review` where possible errors must be proven or disproven, write `final_summary.md`, compact, then enter done.
- `done`: present the result and wait. The user can run `/planner-finish` to export `output/<plan-id>`, or request changes; change requests append context and return to planning without repeating completed work.
- `recovery`: inspect persisted state, Git reality, worktree state, and conflicts before repairing or resuming.

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
	"compact": { "stage": true, "task": false },
	"idle": { "enabled": true, "timeoutMinutes": 10 },
	"metadata": { "humanLanguage": "English" },
	"timer": {
		"enabled": true,
		"mode": "status",
		"showCheckpoints": true,
		"maxCheckpoints": 5,
		"syncIntervalMinutes": 10
	}
}
```

Settings merge in this order: defaults, global settings, then project settings.

`worktree` and `compact` settings are captured when a plan is created. Changing them later does not move an existing worktree or rewrite that plan's saved `state.compactBoundaries`. `idle`, `timer`, and `metadata` settings are read while the planner is running.

| Setting | Default | Purpose |
| --- | --- | --- |
| `worktree.mode` | `"project-local"` | Store worktrees under `<project-root>/.pi/pi-code-planner/worktrees/`. |
| `worktree.root` | unset | Required only when `worktree.mode` is `"custom"`; stores worktrees under that absolute directory. |
| `compact.stage` | `true` | Request planner-controlled compaction at stage boundaries. |
| `compact.task` | `false` | Request planner-controlled compaction at task boundaries. |
| `idle.enabled` | `true` | Enable the idle watchdog that wakes a running plan after inactivity. |
| `idle.timeoutMinutes` | `10` | Minutes since the last planner/tool activity before the idle wake-up. |
| `timer.enabled` | `true` | Show or hide passive planner runtime telemetry. |
| `timer.mode` | `"status"` | `"status"` shows one footer line; `"widget"` shows a passive block above the editor. |
| `timer.showCheckpoints` | `true` | Include recent stage checkpoint timings. |
| `timer.maxCheckpoints` | `5` | Maximum checkpoint entries shown. |
| `timer.syncIntervalMinutes` | `10` | How often timer heartbeat state is written to disk. |

Metadata language settings affect human-facing generated text only. Tool names, JSON fields, branch names, plan ids, parser headings, and code stay stable.

| Metadata setting | Default | Used for |
| --- | --- | --- |
| `humanLanguage` | `"English"` | Default language for user-facing planner text. |
| `titleLanguage` | `humanLanguage` | Plan title proposed through `planner_goal_submit`. |
| `descriptionLanguage` | `humanLanguage` | Short `/planner-resume` list description. |
| `commitLanguage` | `humanLanguage` | Human-readable parts of planner commit messages. Conventional prefixes stay technical. |
| `doubtReviewLanguage` | `humanLanguage` | Human-readable content inside `finalize/doubt_review`. The parser heading `Possible Errors` remains stable. |
| `skillLanguage` | `humanLanguage` | Human-readable body text for planner-generated Pi skills. Skill names and YAML structure stay technical. |

Planner may create Pi skills from verified reusable lessons during stuck/debug/refactor/doubt/finalize work. They are stored under `getAgentDir()/extensions/pi-code-planner/skills/` and exposed to future planner sessions through Pi `resources_discover`. Current selection is simple: every `active` skill in `skills/index.json` with an existing `SKILL.md` is loaded. They are future memory, not a replacement for the current stage instructions.

### Runtime Timer

The runtime timer is only user-facing TUI telemetry. It is separate from the idle watchdog and does not wake the model.

`timer.mode: "status"` shows one compact footer status. `timer.mode: "widget"` shows a passive block above the editor. The timer stores only coarse events in `state.json`: start, stage checkpoints, pause/resume/finish, and a heartbeat every `timer.syncIntervalMinutes`. Live seconds are rendered from memory and are not written to disk.

After a sudden shutdown, the timer resumes from the last heartbeat and caps the missing active-time window to one sync interval instead of counting offline wall-clock time.

### Idle Timer

The idle watchdog is a planner wake-up timer, not a recovery engine. It sends a queued `[SYSTEM_INSTRUCTIONS]` follow-up when an active plan has had no planner/tool calls for `idle.timeoutMinutes`.

It runs only while a planner step is `running`, the plan was activated through `/planner-create` or `/planner-resume`, and the plan is not waiting for user input, recovery, or compact.

It is disabled on `done`, `recovery`, `compact_*`, user approval/acceptance waits, and discovery questions that are already waiting for answers. In `execution`, it runs only on TDD/check/implementation/refactor steps. If the model is truly stuck, it should call `planner_report_stuck`, which saves diff artifacts and starts a controlled compact.

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

Release notes and npm publishing flow are described in `RELEASING.md`.

## Safety ⚠️

- Pi extensions execute with the permissions of the Pi process.
- Persisted state reduces context loss but cannot make model output correct.
- Git wrappers reduce workflow drift but do not replace code review.
- Keep backups of important repositories.

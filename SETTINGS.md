# pi-code-planner Settings

Optional settings files (merged in order: defaults → global → project):

```
getAgentDir()/extensions/pi-code-planner/settings.json
<project-root>/.pi/pi-code-planner/settings.json
```

`worktree` and `compact` are captured at plan creation and don't change mid-plan. All other settings are read while the planner is running.

## Full Example

```json
{
  "worktree": { "mode": "custom", "root": "/mnt/fast/pi-worktrees" },
  "compact": { "stage": true, "task": false },
  "idle": { "enabled": true, "timeoutMinutes": 10 },
  "exec": { "defaultTimeoutSeconds": 240, "maxTimeoutSeconds": 1800, "maxOutputBytes": 10485760 },
  "metadata": {
    "humanLanguage": "English",
    "titleLanguage": "English",
    "descriptionLanguage": "English",
    "commitLanguage": "English",
    "doubtReviewLanguage": "English",
    "skillLanguage": "English"
  },
  "timer": {
    "enabled": true,
    "mode": "status",
    "showCheckpoints": true,
    "maxCheckpoints": 5,
    "syncIntervalMinutes": 10
  },
  "skills": {
    "enabled": true,
    "maxActive": 0
  },
  "contracts": {
    "enabled": true,
    "finalPolicy": "ask",
    "scanBatchSize": 10,
    "statusCharBudget": 12000,
    "readChunkChars": 6000,
    "maxActiveChains": 3,
    "levelBudgets": {
      "root": 1800,
      "ancestor": 3000,
      "nearest": 7000
    },
    "requireAfterTdd": true,
    "requireBeforeEditOutsideChain": true
  },
  "workspace": {
    "enabled": true,
    "autoOpen": true,
    "footerReserveRows": 3
  }
}
```

## Worktree

| Setting | Default | Purpose |
| --- | --- | --- |
| `worktree.mode` | `"project-local"` | `"project-local"` stores under `<project-root>/.pi/pi-code-planner/worktrees/`. `"custom"` uses `worktree.root`. |
| `worktree.root` | unset | Absolute path for custom worktree storage. Required when `mode` is `"custom"`. |

## Compact

| Setting | Default | Purpose |
| --- | --- | --- |
| `compact.stage` | `true` | Request planner-controlled compaction at stage boundaries. |
| `compact.task` | `false` | Request planner-controlled compaction at task boundaries. |

## Idle Watchdog

Sends a follow-up when an active plan has had no planner/tool calls for `timeoutMinutes`. Disabled during `done`, `recovery`, compact steps, and user-input waits.

| Setting | Default | Purpose |
| --- | --- | --- |
| `idle.enabled` | `true` | Enable the idle watchdog. |
| `idle.timeoutMinutes` | `10` | Minutes of inactivity before the watchdog fires. |

## Exec (Shell Commands)

`planner_exec` runs a shell command inside the planner worktree and returns stdout + stderr. The idle watchdog is paused for the entire duration of the command.

| Setting | Default | Purpose |
| --- | --- | --- |
| `exec.defaultTimeoutSeconds` | `240` | Timeout used when the model does not pass `timeoutSeconds`. The process is killed on expiry. |
| `exec.maxTimeoutSeconds` | `1800` | Hard ceiling for `timeoutSeconds`. The model cannot exceed this value regardless of what it requests. |
| `exec.maxOutputBytes` | `10485760` | Maximum bytes collected from stdout+stderr combined. Output beyond this limit is silently dropped and a truncation note is appended to the result. |

## Timer

User-facing TUI telemetry only. Does not wake the model.

| Setting | Default | Purpose |
| --- | --- | --- |
| `timer.enabled` | `true` | Show or hide planner runtime telemetry. |
| `timer.mode` | `"status"` | `"status"` = one compact footer line. `"widget"` = passive block above editor. |
| `timer.showCheckpoints` | `true` | Include recent stage checkpoint timings. |
| `timer.maxCheckpoints` | `5` | Maximum checkpoint entries shown. |
| `timer.syncIntervalMinutes` | `10` | How often heartbeat state is written to disk. |

## Metadata (Language)

Affects human-facing generated text only. Tool names, JSON fields, branch names, and code stay in English.

| Setting | Default | Purpose |
| --- | --- | --- |
| `metadata.humanLanguage` | `"English"` | Default for all language settings below. |
| `metadata.titleLanguage` | `humanLanguage` | Plan title proposed through `planner_goal_submit`. |
| `metadata.descriptionLanguage` | `humanLanguage` | Short `/planner-resume` list description. |
| `metadata.commitLanguage` | `humanLanguage` | Human-readable parts of planner commit messages. |
| `metadata.doubtReviewLanguage` | `humanLanguage` | Human-readable content inside `finalize/doubt_review`. |
| `metadata.skillLanguage` | `humanLanguage` | Body text for planner-generated Pi skills. |

## Skills

Planner-generated skills are stored under `getAgentDir()/extensions/pi-code-planner/skills/` and exposed only to active planner sessions through Pi `resources_discover`. Use `/planner-skills` to search, inspect, or delete them.

| Setting | Default | Purpose |
| --- | --- | --- |
| `skills.enabled` | `true` | Expose planner-generated skills to active sessions. |
| `skills.maxActive` | `0` | Max skills exposed; `0` = no limit. Newer skills are preferred when capped. |

## Contracts (AGENTS.md)

| Setting | Default | Purpose |
| --- | --- | --- |
| `contracts.enabled` | `true` | Enable AGENTS.md contract discovery, routing, checks, and upserts. |
| `contracts.finalPolicy` | `"ask"` | What `/planner-finish` does with planner AGENTS.md changes: `"ask"`, `"keep"`, or `"remove"`. |
| `contracts.scanBatchSize` | `10` | Directories scanned per `planner_contract_scan` call. |
| `contracts.statusCharBudget` | `12000` | Max contract-summary characters shown in `planner_status`. |
| `contracts.readChunkChars` | `6000` | Chunk size for `planner_contract_read`. |
| `contracts.maxActiveChains` | `3` | Max active contract chains kept in `state.json`. |
| `contracts.levelBudgets.root` | `1800` | Summary budget for root-level routing contracts. |
| `contracts.levelBudgets.ancestor` | `3000` | Summary budget for intermediate domain contracts. |
| `contracts.levelBudgets.nearest` | `7000` | Summary budget for the nearest applicable domain contract. |
| `contracts.requireAfterTdd` | `true` | Require `execution/contract_check` after a green implementation. |
| `contracts.requireBeforeEditOutsideChain` | `true` | Instruct the model to route/read contracts before leaving declared task scope. |

## Workspace (TUI)

`/planner-dashboard` opens the planner workspace: the stage dashboard and the model chat in one window. It also opens automatically for planner-worktree sessions (after `/planner-create`, `/planner-resume`, `/planner-improve`).

| Setting | Default | Purpose |
| --- | --- | --- |
| `workspace.enabled` | `true` | Master switch for the workspace window. |
| `workspace.autoOpen` | `true` | Open the workspace automatically for planner-worktree sessions. |
| `workspace.footerReserveRows` | `3` | Terminal rows left for Pi's native footer below the workspace overlay. Raise if the footer overlaps; lower if there is a gap. `0`–`20`. |

### Workspace keys

Inside the workspace, `Tab` cycles three focus panes:

| Pane | Keys |
| --- | --- |
| input | type or paste, `Enter` to send to the model |
| chat | `↑`/`↓`, `PageUp`/`PageDown` scroll; `End` jumps back to the live tail, `Home` to the top; `x` toggles expand-all for collapsed tool calls |
| tasks | `↑`/`↓` select a task and reveal the task list + stage timings; `←`/`→` nudge the ticker |

While scrolled up, the transcript stays anchored — new streamed output appends below without moving your view. Press `End` to jump back to the live tail. History is projected as a sliding window over the session (a chunk of trailing entries); scrolling to the top loads the next older chunk, so very long sessions never project the whole conversation at once.

Pasting text into the input works (bracketed paste is handled; newlines fold to spaces). Pasting **images** is not supported in the workspace window — Pi's image paste targets its built-in editor, which the workspace replaces; close the workspace (`Esc`) to use the plain editor for image input.

The workspace also inherits two Pi bindings (work in any pane): `app.thinking.toggle` (default `Ctrl+T`) shows/hides thinking blocks, and `app.tools.expand` (default `Ctrl+O`) expands/collapses tool output. Rebind them in `~/.pi/agent/keybindings.json`.

The workspace's own keys are configurable in planner settings (Pi's `keybindings.json` only accepts Pi's built-in action ids, not ours). Override any of them under `workspace.keys`; omitted actions keep their defaults:

```json
{ "workspace": { "keys": { "jumpBottom": ["end", "ctrl+e"], "expand": ["x", "o"] } } }
```

Actions: `focusNext` (`tab`), `up` (`up`), `down` (`down`), `pageUp` (`pageUp`), `pageDown` (`pageDown`), `jumpBottom` (`end`), `jumpTop` (`home`), `expand` (`x`), `submit` (`enter`), `exit` (`escape`). `Ctrl+C` always exits regardless of overrides.

The line under the stage ribbon is a static context line (active task, branch, or a blocking note), clipped with `…` — it does not scroll, so it never forces a repaint.

`Esc` (or `Ctrl+C`) closes the workspace and returns to the plain chat. Streaming assistant output appears live, token by token.

### Pi keybindings

The workspace keys above are handled by the extension. Pi's own shortcuts (cursor movement, model/thinking selectors, tool expansion, etc.) are configured globally in `~/.pi/agent/keybindings.json` using namespaced ids such as `tui.editor.cursorUp` and `app.tools.expand`. Each id maps to one key or an array of keys; run `/reload` after editing. See the Pi keybindings documentation for the full list.

## Instruction Append Files

Place extra instructions (test commands, architecture notes, commit style) under:

```
getAgentDir()/extensions/pi-code-planner/instructions/append/
<project-root>/.pi/pi-code-planner/instructions/append/
```

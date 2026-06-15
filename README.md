> ⚠️ This repository is an experiment built with Pi and Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf for local coding work. It is maintained with local AI assistance and may contain non-professional design choices, rough edges, broken behavior, or mistakes. Use it at your own risk.

# pi-code-planner

<p align="center">
  <img src="assets/icon.webp" alt="pi-code-planner icon" width="120">
</p>

An experimental [Pi](https://github.com/badlogic/pi-mono) extension for local coding models. Adds a persisted state machine so long tasks survive context compaction, Git branching, and approval steps without you babysitting the session.

Tested with [Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF). The model still makes mistakes — sometimes it spirals on a wrong hypothesis, sometimes it misreads the persisted state. But the failure mode changes: instead of silently drifting, it tends to get stuck in a visible way and either self-corrects or calls `planner_report_stuck`. In practice, a session implementing a nontrivial feature went about 3 hours without me touching it. That is the goal.

---

## Install

```bash
pi install npm:pi-code-planner
```

Or from source:

```bash
pi install git:github.com/m62624/pi-code-planner
```

Open Pi inside a Git project and run `/planner-create`.

> If `Shift+Enter` doesn't insert a new line in the editor, add `"tui.input.newLine": ["ctrl+j"]` to `~/.pi/agent/keybindings.json` and run `/reload`.

---

## Workflow

```
user request
  → normalize and approve goal
  → scan AGENTS.md contracts, inspect relevant files
  → persist discovery.md
  → write plan.md, split into tasks
  → for each task: write tests → implement → update AGENTS.md contracts → refactor → verify → merge
  → verify integrated plan branch
  → doubt_review: prove or disprove possible errors
  → ask user to accept
  → export output/<plan-id> branch with full task history
```

After compaction, the model calls `planner_status`, reloads from persisted JSON/Markdown artifacts, and continues. Chat is not the source of truth — artifacts are.

---

## Commands

| Command | Purpose |
| --- | --- |
| `/planner-create` | Create a new plan from a multiline request. Opens the planner workspace. |
| `/planner-improve` | Discovery-first self-improvement plan. Opens the planner workspace. |
| `/planner-resume` | Pick a plan and resume its worktree session. Opens the planner workspace. |
| `/planner-dashboard` | Open the planner workspace: live stage dashboard, task list, and the model chat in one window. Opens automatically for planner-worktree sessions. |
| `/planner-helper` | Show current effective settings and planner behavior. |
| `/planner-skills` | Search, view, and delete planner-generated skills. |
| `/planner-finish` | Export `output/<plan-id>`, remove temporary planner state, return Pi to the original session. |
| `/planner-exit` | Return to the original session without finishing or deleting the plan. |
| `/planner-delete` | Delete a plan after confirmation. |
| `/planner-rename` | Rename a plan title. |

---

## Git Branches

```
base → plan/<plan-id> → task/<plan-id>/<task-id> → output/<plan-id>
```

Each plan owns one isolated worktree and one protected plan branch. Temporary task branches are removed after merge. Output branch keeps the full commit history from all tasks.

While a plan is active, raw `git` is blocked. Use planner Git wrappers. Run tests and builds from the worktree path reported by `planner_status`.

---

## Settings

See [SETTINGS.md](SETTINGS.md) for the full reference — worktree, compact, idle watchdog, timer, metadata language, skills, and contracts.

---

## AGENTS.md Contracts

The planner treats `AGENTS.md` files as local architecture contracts — durable model-facing memory that routes the model through the project without reading irrelevant code first. Inspired by [DOX](https://github.com/agent0ai/dox).

Contracts are written only through `planner_contract_upsert`. The planner tracks touched files in `state.json` and keeps baselines so `/planner-finish` can remove or restore them.

---

## Development

```bash
git clone https://github.com/m62624/pi-code-planner.git
cd pi-code-planner
npm install
npm run build
pi -e ./src/index.ts
```

---

## License

[MIT](https://github.com/m62624/pi-code-planner/blob/main/LICENSE)

> ⚠️ Experimental. pi-code-planner is built **for local coding models** and, at runtime, is driven by one — a small local model (tested with Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf) running through Pi. Cloud LLMs (such as Claude) take part in its development. It is maintained with AI assistance and may contain non-professional design choices, rough edges, broken behavior, or mistakes. Use it at your own risk.

# pi-code-planner

<p align="center">
  <img src="assets/icon.webp" alt="pi-code-planner icon" width="120">
</p>

An experimental [Pi](https://github.com/badlogic/pi-mono) extension for local coding models. Adds a persisted state machine so long tasks survive context compaction, Git branching, and user approval steps without babysitting the session.

> Not a guarantee of better output. In practice, a session implementing a nontrivial feature ran about 3 hours untouched. That is the goal.

---

## Install

Released versions, published to npm:

```bash
pi install npm:pi-code-planner
```

Developer version — the latest `main`, including changes not yet released to npm:

```bash
pi install git:github.com/m62624/pi-code-planner
```

Both channels can have bugs; the difference is only what they track — npm follows tagged releases, GitHub follows `main`. Pick npm for released versions and GitHub to try the newest changes.

Open Pi inside a Git project and run `/planner-create`.

> If `Shift+Enter` doesn't insert a new line, add `"tui.input.newLine": ["ctrl+j"]` to `~/.pi/agent/keybindings.json` and run `/reload`.

---

## How it works

```mermaid
flowchart TD
    S([user runs /planner-create]) --> INIT

    INIT["**init** — bootstrap worktree and plan record"]
    INTAKE["**intake** — write and approve goal"]
    DISCOVERY["**discovery** — scan project, write verification protocol"]
    PLANNING["**planning** — write plan.md, split into tasks, consistency check"]
    EXECUTION["**execution** — TDD → implement → contracts → refactor → merge"]
    FINALIZE["**finalize** — integration check, doubt review, summary"]
    DONE["**done** — present result, await user acceptance"]
    RECOVERY["**recovery** — diagnose and repair broken state"]
    OUT([output/&lt;plan-id&gt; branch])

    INIT --> INTAKE
    INTAKE --> DISCOVERY
    DISCOVERY --> PLANNING
    PLANNING --> EXECUTION
    EXECUTION -->|"next task"| EXECUTION
    EXECUTION -->|"all done"| FINALIZE
    FINALIZE --> DONE
    DONE -->|"/planner-finish"| OUT
    DONE -->|"change request"| PLANNING

    INIT & INTAKE & DISCOVERY & PLANNING & EXECUTION & FINALIZE -.->|"broken / stuck"| RECOVERY
    RECOVERY -.->|"resume"| INIT
```

**Runs on its own** through init, discovery, planning, execution, and finalize.

**Stops and waits for you** at two moments:
- **intake** — approves the goal before planning starts
- **done** — waits for `/planner-finish` or a correction

| Stage | Who drives it |
| --- | --- |
| init | Automated |
| intake | **You approve the goal** |
| discovery | Automated |
| planning | Automated |
| execution | Automated (repeated per task) |
| finalize | Automated |
| done | **You run `/planner-finish`** |
| recovery | Automated, may ask before destructive repairs |

---

## Settings

See [SETTINGS.md](SETTINGS.md) for the full reference.

**Idle watchdog** (`idle.timeoutMinutes`) — wakes the model when it goes silent mid-step.

The watchdog sends a wake-up message when the model has made no planner tool call for `timeoutMinutes`. This handles the common case where the model pauses mid-step — a long inference, a generation that produced prose instead of a tool call, or a context edge case. The wake message tells it to call `planner_status` and continue from the persisted state.

The right value depends on your model's inference speed. If the timeout is too short, the watchdog fires during normal generation and interrupts a step in progress. Too long, and a genuinely stuck model sits idle for a long time before recovery.

| Speed | Recommended |
| --- | --- |
| < 5 tok/s | `20` |
| 5–15 tok/s | `15` |
| 15–30 tok/s | `10` |
| > 30 tok/s | `6` |

> `timer.syncIntervalMinutes` is separate — it only controls how often the TUI clock saves telemetry, it does not wake the model.

---

## Commands

| Command | Purpose |
| --- | --- |
| `/planner-create` | Create a new plan from a request |
| `/planner-resume` | Resume an existing plan |
| `/planner-finish` | Export result, clean up state |
| `/planner-dashboard` | Open the live stage dashboard |
| `/planner-improve` | Discovery-first self-improvement plan |
| `/planner-skills` | Search and manage planner-generated skills |
| `/planner-exit` | Return to the original session without finishing |
| `/planner-delete` | Delete a plan |
| `/planner-rename` | Rename a plan |
| `/planner-helper` | Show current effective settings |

---

## Git Branches

```
base → plan/<plan-id> → task/<plan-id>/<task-id> → output/<plan-id>
```

Raw `git` is blocked while a plan is active. Use planner Git wrappers. Run tests from the worktree path reported by `planner_status`.

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

## Why local, and why this exists

These are closer to notes out loud than a pitch.

After a few months of using both cloud and local models day to day, one thing became clear to me: **the harness decides as much as the model does.** How work is framed, bounded, and fed to the model matters about as much as which model it is. Pi happens to give fine-grained control over exactly that — a minimal core that doesn't bloat the context and an extension API flexible enough to reshape the whole loop. That is why I picked Pi as the base for this rather than something heavier.

Why local, specifically? Over these months the token economics shifted — running everything through a cloud model got noticeably expensive — and I'm already used to working with neural nets and run them myself. For small and mid-size tasks I use **[Qwen3.6-35B-A3B](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-MTP-GGUF)** (the experiment here was carried out only on this model, specifically the `Qwen3.6-35B-A3B-UD-Q4_K_XL.gguf` quant), with the context set to **131k** for my hardware, at roughly **30–40 t/s** depending on how full the window is. Their output is still not optimal. But given where things are heading — more and cheaper hardware, better optimization aimed at local inference — I expect that handing at least the simpler tasks to a small local model for the sake of cost will become normal before long. So I wrote this extension for myself: to help my own local model carry development work, and to be ready for when that's the default rather than the exception.

It does **not** make the model smarter — nothing here adds reasoning. It adds boundaries and moves out of the model the parts a small model is worst at. The failure mode of a local model on a medium or large codebase is rarely a wrong line; it is loss of coherence over distance — facts that don't fit in the window together, drift across compaction, a decision contradicted ten steps later, "done" declared early. So each stage removes one degree of freedom:

- **Persisted state** — plan, tasks, decisions, and the current step live on disk, not in chat; they survive compaction and are reconstructed via `planner_status`.
- **Forced order** — no implementation before discovery, no production code before tests, no "done" with pending tasks; a guard holds a model that "feels finished" to the protocol.
- **Per-task Git isolation** — one task, one branch, one merge; a bad task is contained instead of smearing across the change.
- **Local contracts (AGENTS.md)** — scope is pinned to the relevant directory chain instead of guessed.
- **Mechanical consistency ([elenchus](https://github.com/m62624/elenchus))** — the model states only facts and first principles in a tiny DSL; a wasm SAT engine does the inference and reports `CONSISTENT / WARNING / UNDERDETERMINED / CONFLICT` with the premises to blame, so the model can only be wrong at the premise level and that is caught immediately. It is a soft gate with a `not_applicable` escape, so it never traps simple work.

Honest expectation: results are not ideal, and this project is itself largely a product of vibe coding. Output quality tracks the clarity of the request far more than the structure does — a vague task makes the overhead a net loss, while a precise one with testable criteria lets a weak model stay on rails for hours. It is a trade, not a guarantee; sometimes the structure pays off and sometimes it does not. But Pi's minimalism — not loading the context, staying flexibly extensible — is exactly what makes it possible to prop a local model up now and to be prepared for when this becomes the norm.

## License

[MIT](https://github.com/m62624/pi-code-planner/blob/main/LICENSE)

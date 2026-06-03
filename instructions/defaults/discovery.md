# discovery

## Purpose

Become familiar with the project before planning. Keep this stage cheap for a local model: inspect the project tree, read only the files needed for the approved goal, and summarize useful findings in `discovery.md`.

## Strict Step Order

1. `scan_project_structure`
   - Read `goal.md`.
   - Inspect the project tree with read-only shell commands.
   - Read only the manifests, entrypoints, tests, configuration, and source files needed to understand the requested work.
   - Write a concise `discovery.md`: architecture, relevant paths, commands, conventions, risks, and uncertainty.
2. `write_questions`
   - Call `planner_questions_submit` with evidence-based unresolved questions and explicit assumptions.
   - If questions exist, show them to the user verbatim and wait for answers.
   - Call `planner_questions_resolve` with the user's explicit answers.
   - If no questions remain, call `planner_questions_submit` with `hasOpenQuestions: false` and state that explicitly.
3. `compact_discovery`
   - Request planner-controlled compact only after `discovery.md` is useful and questions are resolved.
4. `enter_planning`
   - Advance to `planning/read_context`.

## Restrictions

- Do not implement production code or tests.
- Do not read the whole repository by default.
- Do not build or maintain a file-by-file JSONL symbol index.
- Run project-scoped shell commands from the worktree path reported by `planner_status`.
- Do not use raw git.

## Exit Condition

Discovery is complete when `discovery.md` contains enough context for planning, required user questions are answered or explicitly absent, and the configured discovery compact boundary finishes.

## Fundamental Rules

### Rule 1: System Boundaries

Before reading any file, determine two things:

**Internal** — files inside the project that you can read and edit. Code, configs, tests, project documentation.

**External** — everything outside the project. Host mechanisms, external APIs, runtime environments, servers, models, browsers, file systems outside the project root.

**Rule:** You do not write external code. You use or call external mechanisms. If a task requires an action performed by an external mechanism — the solution is in HOW to call the external mechanism, not in rewriting its code.

**Deduction:** If the task says "make X happen" and X is performed by an external mechanism — you do not write X. You find the integration point where the project can ASK the external mechanism to do X.

### Rule 2: Mechanism vs Outcome

Every requirement has two layers:

- **Outcome** — what should happen. The end state.
- **Mechanism** — HOW it happens. The means of achievement.

**Rule:** You investigate, you do not guess. When a task describes an outcome, you must NOT automatically think "I need to write code for this." Your first step is to investigate:

1. Is there already a mechanism in the project that can do this? Hooks, events, handlers, scheduler?
2. Is there a mechanism in the external world that can do this? Host API, ready-made integration?
3. Do you need new code, or just CONNECT to an existing mechanism?

Code is the last option. Not the first.

**Deduction:** Before writing a single line of code, you determine the mechanism. If the mechanism can be external — you find how to interact with it. If the mechanism already exists in the project — you connect to it. New code is written only when nothing suitable is found.

## manual-compact

Preserve the approved goal, `discovery.md`, relevant paths, commands, open questions, and exact current planner step. After compaction, call `planner_status`.

## auto-compact

Call `planner_status` immediately. Read `discovery.md` and continue the persisted step. Read additional source files only when the current context is insufficient.

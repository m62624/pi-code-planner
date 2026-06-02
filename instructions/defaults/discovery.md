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

## manual-compact

Preserve the approved goal, `discovery.md`, relevant paths, commands, open questions, and exact current planner step. After compaction, call `planner_status`.

## auto-compact

Call `planner_status` immediately. Read `discovery.md` and continue the persisted step. Read additional source files only when the current context is insufficient.

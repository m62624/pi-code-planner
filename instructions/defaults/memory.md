# memory

## Purpose

Keep project understanding cheap for a context-limited local model. Planner memory is a bounded retrieval aid, not a durable mirror of every file, symbol, relation, or commit.

## Available Retrieval

1. Call `planner_memory_project_map` for a mechanical overview of project areas, languages, manifests, entrypoints, tests, and configuration paths.
2. Call `planner_memory_search_project` with a task-oriented query for bounded ranked excerpts.
3. Refine the query when context is insufficient.
4. Read source files directly only when the overview and excerpts are not enough or when the current change requires exact verification.

Both retrieval wrappers are CPU-only. They do not start another model, consume VRAM, or require a full-project indexing pass.

## Restrictions

- Do not read the whole repository by default.
- Do not create a file-by-file indexing queue.
- Do not maintain JSONL symbol, relation, dirty-state, or checkpoint files.
- Do not block normal implementation after commit or merge for memory synchronization.

## manual-compact

Preserve the approved goal, active task, relevant paths, useful search queries, and `discovery.md`. After compaction, call `planner_status`.

## auto-compact

Call `planner_status` immediately. Read the current task artifacts and `discovery.md`. Search the project again only when context is insufficient.

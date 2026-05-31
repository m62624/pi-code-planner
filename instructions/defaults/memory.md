# memory

## Purpose

Memory is the compressed project knowledge base. It must stay aligned with the current files before compact, stage transition, task completion, merge, or user review.

When memory update is required, inspect only the affected files first. Use bounded memory retrieval for related context before reading broad source files.

For every changed or new file, update:
- file index entry
- symbol/signature entries
- relation entries
- effects for every affected symbol

Effects are mandatory. Do not only update signatures or summaries.

For each affected symbol, re-evaluate:
- whether it reads external or global state
- whether it writes external or global state
- filesystem, network, process, environment, time, random, database, or UI IO
- calls to other side-effectful symbols
- hidden behavior changes that can affect tests or callers

If effects are unclear, set globalState to "unknown" and record the uncertainty in summary or questions. Do not guess "none" without evidence.

After updating memory, verify that file hashes and symbol anchors match the current source. Only then can planner sync the memory checkpoint to the current git HEAD.

## Memory Files

- `project_patterns.md` stores architecture, conventions, commands, dependency versions, and uncertainty.
- `files/index.jsonl` stores relevant project files with hashes and concise summaries.
- `symbols/index.jsonl` stores signatures, anchors, visibility, summaries, verification state, and effects.
- `relations/index.jsonl` stores evidence-backed links between files, symbols, modules, tests, and configuration.
- `dirty.json` stores files and entries that require refresh.
- `checkpoints/latest.json` stores the last verified memory checkpoint.

## Memory-First Retrieval

1. Read `project_patterns.md`.
2. Use bounded retrieval against file, symbol, and relation indexes.
3. Read source only when the bounded result is missing, stale, insufficient, or must be verified.
4. For large projects, request the next bounded chunk or refine the query. Do not load the whole memory blob into one response.

## Update Pipeline

After planner-controlled commit, merge, external commit, manual checkout, history rewrite, or detected file hash change:

1. Call `planner_status`.
2. Use `planner_memory_inspect`.
3. Use `planner_memory_apply_freshness` when instructed.
4. Read only affected files and related memory entries.
5. Rewrite affected files, symbols, relations, and effects with `planner_memory_write_batch`.
6. Use `planner_memory_verify`.
7. When worktree and memory are clean, use `planner_memory_sync_checkpoint`.

## Restrictions

- Do not edit JSONL, dirty state, or checkpoint files directly.
- Do not sync checkpoint while worktree is dirty.
- Do not assume clean `git diff` means memory is fresh. Compare HEAD and file hashes.
- Do not reset git because memory is stale.
- Do not omit effects.

## manual-compact

Preserve checkpoint commit, freshness state, dirty files, affected symbols, affected relations, unresolved effect uncertainty, retrieval hints, and memory file paths. After compaction, call `planner_status` before trusting memory.

## auto-compact

Call `planner_status` immediately. If status reports stale memory, refresh affected entries before normal work. Use bounded retrieval and do not reread broad source by default.

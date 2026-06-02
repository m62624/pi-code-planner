# discovery

## Purpose

Build selective durable project memory before planning or implementation. Discovery is intentionally strict: search mechanically, preserve only useful files, then inspect exactly one selected queued file at a time. Never rely on chat history as indexing state.

## Strict Step Order

1. `scan_project_structure`
   - Call `planner_memory_project_map` once. Use its bounded mechanical overview to identify top-level areas, manifests, entrypoints, tests, and config paths without reading every source file.
   - Build a focused query from the approved goal and call `planner_memory_search_project`.
   - Inspect bounded ranked excerpts. Broaden or refine the query only when context is insufficient.
   - Call `planner_memory_scan_project` with the smallest relevant `paths` set worth preserving.
   - The extension writes the selective queue to `memory/indexing.json`.
   - Call `planner_memory_index_status` and inspect the durable queue summary.
   - Do not queue every repository file by default and do not begin broad source reading before the queue exists.
2. `index_files_iteratively`
   - Call `planner_memory_index_status`.
   - If there is no active file, call `planner_memory_next_file`.
   - Read only the active file through `planner_memory_read_chunk`. The wrapper persists `nextUnreadLine`, so long files resume from the exact unread line after compact.
   - Continue reading chunks until `EOF: true`.
   - Call `planner_memory_upsert_active_file` with file kind, language, and a concise responsibility summary.
   - Extract reusable functions, methods, traits, interfaces, types, classes, modules, constants, tests, and other language-specific APIs from the active file.
   - Record symbols with `planner_memory_upsert_symbols` in batches of at most 5. Provide semantic fields only: kind, name, signature, concise summary, exact `anchorSearchText`, and effects. Omit active file path, language, id, hash, and verification fields unless an explicit override is required; the wrapper derives them.
   - Effects must state reads, writes, IO, and global-state behavior. Use `globalState: "unknown"` when evidence is insufficient.
   - Before verification, compare your extracted symbol list against every chunk read from the active file. Check language-specific reusable behavior such as trait or interface methods, implementations, inherited behavior, private reusable helpers, tests, and hidden side effects. The wrapper validates mechanical evidence; you validate semantics.
   - Call `planner_memory_verify_active_file`. The wrapper checks that the file was fully read, its hash did not change, and every candidate anchor still exists in source.
   - Call `planner_memory_complete_active_file`. The wrapper rechecks the file, removes stale symbols and relations from earlier versions, and clears the active file.
   - Repeat until `planner_memory_index_status` reports `Complete: true`.
   - Use `planner_memory_ignore_active_file` only for intentionally excluded generated, vendor, or non-semantic files. Provide an explicit durable summary.
3. `write_project_patterns`
   - Use `planner_memory_write_project_patterns` to write evidence-backed architecture, conventions, dependency versions, build commands, test commands, formatting commands, risks, and uncertainty.
4. `write_relations`
   - Use `planner_memory_upsert_relations` in batches of at most 5 for evidence-backed relations such as calls, implements, extends, tests, configures, depends_on, exposes, reads, and writes. Prefer a unique symbol name or qualified name; use generated ids only when a name is ambiguous. Omit `evidencePath` when the relation evidence is in the `from` symbol file.
   - Relation evidence must contain a project-relative file path and an exact source substring.
   - Relationships may be recorded after file indexing because cross-file meaning is clearer when reusable symbols are already available.
   - Review the completed symbol index before leaving this step. Add only important reusable relations; record uncertainty instead of inventing a link.
5. `write_questions`
   - Call `planner_questions_submit` with evidence-based unresolved questions and explicit assumptions for `questions.md`.
   - If unresolved questions exist, the tool returns the exact text to show the user verbatim. Wait for answers before leaving this step.
   - Call `planner_questions_resolve` with the user's explicit answers. The wrapper records answers in both `questions.md` and `decisions.md`, then marks the persisted question gate resolved.
   - If no questions remain, call `planner_questions_submit` with `hasOpenQuestions: false` and say so explicitly in the content; the artifact must not remain empty.
   - Ask the user only after collecting project evidence. Do not ask speculative implementation questions during intake.
6. `verify_memory`
   - Use `planner_memory_inspect`, `planner_memory_verify`, and `planner_memory_sync_checkpoint`.
   - Do not finish the step until hashes, anchors, relation evidence, effects, and the checkpoint are consistent with current HEAD.
7. `compact_discovery`
   - Request planner-controlled compact only after memory is clean and checkpointed.
8. `enter_planning`
   - Advance to `planning/read_memory`.

## Restrictions

- Do not implement production code or tests for the requested change.
- When inspecting project structure, manifests, dependency versions, or available project commands, run every project-scoped shell command from the worktree path reported by `planner_status`, never from the original checkout.
- Do not read multiple queued source files in parallel.
- Do not reread completed files after compact.
- Do not write JSONL, `indexing.json`, dirty state, or checkpoint files directly.
- Do not guess effects or relations. Record `unknown` when evidence is insufficient.
- Do not use raw git.

## Exit Condition

Discovery is complete only when the selective durable file queue is complete, reusable symbols and effects are verified file-by-file, evidence-backed relations and project patterns are written, required user questions are answered or explicitly absent, memory verification passes, the checkpoint is synced, and the configured discovery compact boundary finishes.

## manual-compact

Preserve the user goal, durable indexing mode, active file, exact next unread line, completed file count, pending file count, failed files, project patterns, dependency versions, commands, open questions, memory checkpoint status, and paths to all memory indexes. After compaction, call `planner_status` and continue the exact persisted step. Do not reread completed files.

## auto-compact

Call `planner_status` immediately. If discovery indexing is incomplete, read `memory/indexing.json` through planner status or `planner_memory_index_status`, continue the active file from `nextUnreadLine`, and do not restart discovery. If status reports stale memory, process only the refresh queue.

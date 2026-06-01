# memory

## Purpose

Memory is the durable compressed project knowledge base for context-limited local models. The extension stores mechanical facts and verifies source anchors. The model remains responsible for language semantics: Rust traits, Go interfaces, private helpers, inherited behavior, side effects, and reusable APIs must be interpreted from source evidence.

## Durable Files

- `project_patterns.md` stores architecture, conventions, commands, dependency versions, and uncertainty.
- `indexing.json` stores the durable file queue, active file, hash, line count, next unread line, candidate symbols, and verification state.
- `files/index.jsonl` stores project files with hashes and concise summaries.
- `symbols/index.jsonl` stores signatures, exact anchors, visibility, summaries, verification state, and effects.
- `relations/index.jsonl` stores evidence-backed links between files, symbols, modules, tests, and configuration.
- `dirty.json` stores files requiring refresh.
- `checkpoints/latest.json` stores the last verified memory checkpoint.

## File-By-File Rule

Never index source files as one large trusted batch.

1. Build or resume the queue with `planner_memory_scan_project`.
2. Call `planner_memory_index_status`.
3. Claim one file with `planner_memory_next_file`.
4. Read bounded chunks with `planner_memory_read_chunk` until EOF. Long files resume from the persisted `nextUnreadLine`.
5. Record file metadata with `planner_memory_upsert_active_file`.
6. Record reusable symbols in batches of at most 5 with `planner_memory_upsert_symbols`.
7. Verify the active file with `planner_memory_verify_active_file`.
8. Complete the active file with `planner_memory_complete_active_file`.
9. Repeat until the queue is complete.

The wrapper refuses early completion, changed hashes, stale anchors, cross-file symbol writes, claiming another file while an active file remains incomplete, global verification before queue completion, and checkpoint sync before queue completion.

`indexing.json` is validated whenever it is loaded. Invalid persisted cursors, duplicate files, missing hashes, unsupported statuses, and inconsistent active-file state block progress instead of silently restarting work.

## Semantic Self-Review

Before calling `planner_memory_verify_active_file`, compare the extracted symbols against the complete chunks read for the active file. Check language-specific reusable behavior, trait or interface implementations, inherited behavior, private helpers used by other code, tests, and hidden side effects.

The TypeScript wrapper validates mechanical facts across languages: file hashes, line progress, exact anchors, queue state, relation references, and evidence substrings. It cannot infer every language semantic. When evidence is incomplete, record uncertainty and use `globalState: "unknown"` instead of guessing.

## Effects

For every reusable or changed symbol, re-evaluate:

- external or global state reads
- external or global state writes
- filesystem, network, process, environment, time, random, database, or UI IO
- calls to side-effectful symbols
- hidden behavior changes that affect callers or tests without changing the signature

Effects are mandatory. Use `globalState: "unknown"` when evidence is insufficient. Do not guess `none`.

## Relations

Record cross-file relationships after the relevant symbols exist and the file queue is complete. Use small batches and exact evidence substrings. Relationships include calls, implements, extends, contains, tests, configures, depends_on, exposes, reads, and writes. Review the completed symbol index first so cross-file meaning is evaluated with full project evidence.

## Refresh After Git Changes

After planner-controlled commit, merge, external commit, manual checkout, history rewrite, or detected file hash change:

1. Call `planner_status`.
2. Call `planner_memory_inspect`.
3. Call `planner_memory_apply_freshness` when stale entries must be marked.
4. Call `planner_memory_scan_project` to create a refresh queue containing only changed, new, or missing files.
5. Process the refresh queue file-by-file with the same strict indexing loop.
6. Re-record affected evidence-backed relations.
7. Call `planner_memory_verify`.
8. When the worktree and memory are clean, call `planner_memory_sync_checkpoint`.

Missing files are removed from file, symbol, and relation memory automatically. Completing a refreshed file removes obsolete symbols and relations from its previous version.

## Memory-First Retrieval

After discovery compact:

1. Read `project_patterns.md`.
2. Use bounded `planner_memory_search` queries against files, symbols, and relations.
3. Read source only when memory is missing, stale, insufficient, or requires verification.
4. Request the next bounded page or refine the query for large projects. Do not dump all indexes into one prompt.

## Restrictions

- Do not edit JSONL, `indexing.json`, dirty state, or checkpoint files directly.
- Do not sync checkpoint while the worktree is dirty.
- Do not assume clean `git diff` means memory is fresh. Compare HEAD and file hashes.
- Do not reset git because memory is stale.
- Do not omit effects.

## manual-compact

Preserve checkpoint commit, freshness state, indexing mode, active file, next unread line, queue counts, failed files, dirty files, affected symbols, affected relations, unresolved effect uncertainty, retrieval hints, and memory paths. After compaction, call `planner_status`.

## auto-compact

Call `planner_status` immediately. If a file is active, continue from the exact `nextUnreadLine`. Do not reread completed files. If status reports stale memory, process only the persisted refresh queue before normal work.

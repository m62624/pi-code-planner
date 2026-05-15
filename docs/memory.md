# Project Memory

Project memory is the planner's compressed, disk-backed map of a codebase. It is
created during discovery and refreshed after later edits. It is a cache with
evidence, not the source of truth. The source of truth is always the project
files.

## Storage

Memory lives under:

```text
getAgentDir()/extensions/pi-planner/projects/<projectKey>/memory/
```

The first implementation uses sharded JSONL files plus small JSON indexes:

```text
memory/
  manifest.json
  files/index.jsonl
  symbols/<file-shard>.jsonl
  relations/<file-shard>.jsonl
  indexes/by_file.json
  indexes/by_name.json
  indexes/by_kind.json
  indexes/symbol_shards.json
  indexes/relation_shards.json
  deleted/symbols.jsonl
  deleted/relations.jsonl
  dirty.json
  project_summary.md
  project_patterns.md
  library_versions.json
  open_questions.md
```

Do not store all symbols in one JSON file. A large project should only require
reading the shard and index files needed for the current task.

## Entries

`FileEntry` tracks project files and indexing state:

- `filePath`
- `kind`
- `language`
- `hash`
- `indexStatus`
- `summary`

`SymbolEntry` tracks API-like units in a language-neutral shape:

- `kind`, `name`, `qualifiedName`
- `filePath`
- `signature`
- `summary`
- `visibility`
- `stability`
- `anchors.searchText`
- `evidence.verificationStatus`
- `confidence`

Line numbers are not the primary anchor. Formatting tools move code too easily.
Verification searches the current file for `anchors.searchText` or its
normalized form.

`SymbolRelation` stores graph edges between symbols:

- `calls`
- `implements`
- `extends`
- `embeds`
- `tests`
- `wraps`
- `depends_on`
- and other generic relation kinds

This keeps Rust traits, Go interfaces, TypeScript classes, Python functions, and
unknown languages in one core representation.

## Dirty Files

When a plan is active, the extension syncs dirty memory from `git status`.
Staged, unstaged, untracked, conflicted, and renamed paths are marked dirty
unless ignored by settings. This catches edits made through Pi tools, shell
commands, formatters, or external editors.

Dirty marking does not reindex immediately. It blocks later commit/compact
boundaries until `signature_refresh` updates affected memory entries.

The intended rule is:

- code changes happen
- changed files are marked dirty from git status
- work continues inside the current atomic stage
- before commit/compact, dirty memory must be refreshed or explicitly resolved

## Discovery

Discovery is the only stage allowed to read the project broadly. It should fill
memory in batches:

1. discover project shape
2. build file inventory
3. extract symbols by file/chunk
4. extract relations
5. audit/verify entries
6. compact only after audit passes

Long files must be read to completion before their `FileEntry` becomes
`indexed`. Partial reads leave the file `pending`.

## Public Tools

The model must use planner memory tools instead of editing memory files directly.
The current public API is:

- `planner_memory_status`
- `planner_memory_upsert_files`
- `planner_memory_upsert_symbols`
- `planner_memory_upsert_relations`
- `planner_memory_search_symbols`
- `planner_memory_get_symbols_by_file`
- `planner_memory_get_symbol_context`
- `planner_memory_get_relations`
- `planner_memory_delete_symbol`
- `planner_memory_delete_relation`
- `planner_memory_mark_dirty`
- `planner_memory_get_dirty`
- `planner_memory_clear_dirty`
- `planner_memory_verify_symbol`
- `planner_memory_verify_file`

Discovery should use upsert tools to build file, symbol, and relation indexes.
Later stages should prefer search/context tools and only update dirty files.

Automatic dirty tracking is git-status based, not edit-tool based. The extension
does not try to semantically update symbols during this sync; it only records
which files are stale. `signature_refresh` is the model-facing stage that reads
dirty files, updates file/symbol/relation memory, verifies entries, and clears
dirty flags. `planner_memory_mark_dirty` remains the safe manual API for unusual
cases.

## Blocking Policy

Dirty memory currently blocks protected public tools:

- `planner_request_compact`
- `planner_request_discovery_compact`
- `planner_request_work_item_compact`
- `planner_finish_work_item`
- `planner_transition_work_item` when moving to `work_item_compact_required`

The intent is that an atomic work item cannot commit or compact until
`signature_refresh` updates memory and clears dirty files. Policy is wired
through tool factories as an optional dependency, so later settings can control
which operations enforce it.

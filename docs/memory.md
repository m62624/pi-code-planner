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

After any model edit/write result, the extension should mark changed files dirty.
Dirty marking does not reindex immediately. It blocks later commit/compact
boundaries until `signature_refresh` updates affected memory entries.

The intended rule is:

- edit/write happens
- changed files are marked dirty
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


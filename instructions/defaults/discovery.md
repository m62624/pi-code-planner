# discovery

## Purpose

Read the project broadly once, record evidence-backed understanding, and build compressed project memory. Discovery is the expensive context-loading stage. Later stages must prefer memory over rereading the whole codebase.

## Strict Step Order

1. `read_project`
   - Read the project structure, manifests, relevant configuration, source files, tests, and existing documentation.
   - For long files, read complete bounded chunks until the relevant file is fully understood before marking it indexed.
   - Record architecture facts, dependency versions, conventions, commands, risks, and uncertainty in `discovery.md`.
2. `write_project_patterns`
   - Write evidence-backed architecture and convention notes to `project_patterns.md`.
   - Include how the project is built, tested, formatted, and organized.
3. `write_file_index`
   - Use `planner_memory_write_batch` to index relevant files with hashes, language, kind, status, and concise summaries.
4. `write_symbols`
   - Use `planner_memory_write_batch` to index relevant functions, methods, types, classes, modules, constants, tests, and public APIs.
   - Store signatures, anchors, visibility, verification state, summary, and effects.
5. `write_relations`
   - Use `planner_memory_write_batch` for evidence-backed relations such as calls, tests, depends_on, configures, exposes, reads, and writes.
6. `write_questions`
   - Write focused unresolved questions and explicit assumptions to `questions.md`.
   - Ask the user only after collecting evidence.
7. `verify_memory`
   - Use planner memory tools to inspect, verify, and sync the memory checkpoint to current HEAD.
8. `compact_discovery`
   - Request planner-controlled compact only after memory is clean and checkpointed.
9. `enter_planning`
   - Advance to `planning/read_memory`.

## Restrictions

- Do not implement production code.
- Do not write tests for the requested change yet.
- Built-in project write/edit and mutating shell commands are blocked during discovery. Write only planner markdown artifacts and memory through planner tools.
- Do not create tasks before project memory is written and verified.
- Do not write memory JSONL or checkpoint files directly. Use planner memory tools.
- Do not guess effects or relations. Record `unknown` when evidence is insufficient.
- Do not use raw git.

## Full-Project Read Rule

Broad project reading is expected during `discovery/read_project`. After discovery compact, broad rereads are forbidden unless memory is stale, incomplete, or insufficient for a specific question.

## Exit Condition

Discovery is complete only when project patterns, files, symbols, relations, questions, and effects are recorded; memory verification passes; checkpoint is synced; and the discovery compact boundary finishes.

## manual-compact

Preserve the user goal, discovery summary, architecture patterns, dependency versions, test/build commands, open questions, memory checkpoint status, and paths to all memory indexes. After compaction, call `planner_status`, read `discovery.md`, read `project_patterns.md`, inspect bounded memory, then enter planning. Do not reread the whole project by default.

## auto-compact

Call `planner_status` immediately. Resume the exact stored discovery step. If discovery indexing is incomplete, continue from the persisted artifact and memory state instead of restarting broad reads from scratch. If status reports stale memory, update only affected entries before continuing.

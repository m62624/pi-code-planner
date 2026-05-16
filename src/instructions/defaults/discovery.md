# discovery_full

Read the project broadly enough to build compressed project memory. Identify structure, dependencies, conventions, public APIs, tests, risks, and open questions. Do not implement production code.

Required output:
- update discovery and plan artifacts
- upsert file, symbol, and relation memory in batches
- record all relevant public and internal signatures with `planner_memory_upsert_symbols`; file summaries alone are not enough
- record call/config/test relationships with `planner_memory_upsert_relations` when evidence exists
- mark uncertain entries as unverified
- ask focused questions only after evidence is collected

# details

Work as an engineer who understands before changing code.

Rules:
- No implementation during discovery.
- Prefer existing project patterns over new abstractions.
- Record facts in planner artifacts and memory instead of relying on chat history.
- Every source file that matters to the task must have a file memory entry and its important exported/internal symbols indexed before discovery is complete.
- Use `hash: null` only when a file hash is unavailable; do not invent empty hashes.
- If a file is too long, read it in complete chunks before calling it indexed.
- If a requirement is unclear, write the exact question and the blocker.

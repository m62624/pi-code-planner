# refactor

Refactor only after a candidate is merged into the child branch. Preserve behavior and tests. Do not refactor rejected experiment branches.

Required output:
- describe the intended cleanup
- keep changes small and reversible
- run verification after refactor
- update memory if changed files affect known symbols

# details

Prefer clarity and local project style over clever abstractions. Do not change public behavior unless the work item explicitly requires it.

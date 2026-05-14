# Git Safety

## Public API Boundary

`RunnerGitWriter` is an internal executor only. It must not be exposed directly
to Pi tools, model-facing commands, or planner flows.

Public planner operations must use `GitMutations` or a higher-level tool/recovery
layer. That layer is responsible for policy checks, `pendingOperation`, rereading
the repository state after writes, and updating `state.json`.

## Dangerous Operations

These operations must stay behind policy, runtime state, and `pendingOperation`:

- hard reset
- soft reset
- force delete branch
- merge
- branch switch while a plan is active

`hardResetToExpected` requires explicit confirmation. Raw `hardReset` on
`RunnerGitWriter` is not a public API.

## Branch Names

Git branch names are refs. A branch named `planner/plan` prevents creating
another branch named `planner/plan/work/parser`, because Git cannot use the same
ref path as both a file and a directory.

Use a namespace layout where the main plan branch is a leaf under the plan
namespace:

```text
planner/<plan-id>/main
planner/<plan-id>/work/<work-item-id>
planner/<plan-id>/experiment/<work-item-id>/<attempt-id>
```

## Source Markdown Layout

Code for instruction parsing lives in `src/instructions`.

Bundled markdown templates live in `src/instructions/markdown` so parser code and
markdown files do not share the same directory level.

Generated user-editable instruction files still live under:

```text
getAgentDir()/extensions/pi-planner/instructions/*.md
<project>/.pi/extensions/pi-planner/instructions/*.md
```

Those runtime paths are intentionally separate from bundled source templates.

## Real Git Integration Tests

Real git integration tests must run only inside OS temp directories created via
Node's cross-platform temp APIs:

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = mkdtempSync(join(tmpdir(), "pi-planner-"));

try {
  // run git commands only inside repo
} finally {
  rmSync(repo, { recursive: true, force: true });
}
```

Integration tests must not run destructive git commands in the project checkout.

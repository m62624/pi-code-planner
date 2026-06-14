<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
Git domain: shell execution wrapper, branch naming conventions, worktree lifecycle, and planner-level git operations (create/switch/merge task branches).

### Parent
- `../AGENTS.md`

### Child Index
- (none)

### Stable Contracts
- All git shell calls go through `GitRunner` interface (`node-runner.ts` is the real impl, tests may substitute a mock).
- Branch naming is deterministic: `plan/<id>`, `task/<planId>/<taskId>`, `refactor/<planId>/<taskId>`, `output/<planId>`.
- Worktree add/remove are the only operations that mutate the filesystem outside the project root.

### Read First
- `runner.ts`
- `node-runner.ts`
- `planner-ops.ts`
- `branches.ts`

### Do Not Touch Unless
- Do not add git commands outside `GitRunner` — all callers depend on the interface, not shell strings.
- Do not change branch name patterns without updating `storage/schema.ts` registry and existing plan migrations.

### Domain Details
- `runner.ts` defines the `GitRunner` interface — the only contract callers (`worktree/manager.ts`, `runtime/`) depend on.
- `node-runner.ts` → executes real `git` via `child_process.execFile`; throws `GitCommandError` on non-zero exit.
- `planner-ops.ts` → called by `runtime/` to create/switch task branches; reads `PlanStateRecord` to resolve branch names.
- `branches.ts` → pure naming functions, no I/O; imported by `planner-ops.ts` and `storage/`.
- **Who calls this domain:** `worktree/manager.ts` calls `node-runner.ts` for worktree add/remove; `runtime/workflow-tools.ts` and `runtime/planner-runtime.ts` call `planner-ops.ts` for branch lifecycle.
<!-- pi-code-planner:contracts:end -->

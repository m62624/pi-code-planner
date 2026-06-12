<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
Storage domain for persisted planner records, paths, JSON IO, schema defaults, state normalization, and worktree-to-project mapping.

### Parent
- `../AGENTS.md`

### Child Index
- (none)

### Stable Contracts
- State and plan JSON must be backward-compatible; normalize missing fields instead of breaking old plans.
- Atomic JSON writes are required for planner state and project records.
- Worktree index maps planner worktree cwd back to the original project storage.

### Read First
- `schema.ts`
- `state-store.ts`
- `paths.ts`
- `project-resolver.ts`
- `worktree-index.ts`

### Do Not Touch Unless
- Do not rename persisted JSON fields without migration/normalization tests.
- Do not infer project roots from arbitrary cwd when a worktree index or project record can resolve them.

### Domain Details
- `createInitialPlanState` owns new state defaults.
- `state-store.ts` owns backward-compatible state normalization.
- `project-resolver.ts` must handle original project cwd and planner worktree cwd.
<!-- pi-code-planner:contracts:end -->

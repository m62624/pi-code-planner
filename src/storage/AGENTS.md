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
- `createInitialPlanState` owns new state defaults; every new `PlanStateRecord` field must start here.
- `state-store.ts` owns backward-compatible state normalization: it reads raw JSON and fills missing fields before returning to runtime. Runtime never touches raw JSON directly.
- `project-resolver.ts` must handle both original project cwd and planner worktree cwd — these are different directories and both are valid entry points.
- `worktree-index.ts` persists a `[worktreePath] → projectStorageRoot` mapping so the extension can recover the project when Pi's cwd is the worktree, not the original project.
- **Who writes state:** only `updatePlanState` in `state-store.ts` writes `state.json`. Runtime tools pass a reducer function. Nothing else writes state directly.
- **Who reads state:** `runPlannerOrchestrator` in `runtime/orchestrator.ts` loads state and packages it as `preflight.context`. All runtime tools receive state through the orchestrator context, never by reading storage directly.
- **Schema change blast radius:** adding a field to `PlanStateRecord` requires: (1) `schema.ts` type, (2) `createInitialPlanState` default, (3) `state-store.ts` normalization, (4) tests. Missing any one of these breaks resume for existing plans.
<!-- pi-code-planner:contracts:end -->

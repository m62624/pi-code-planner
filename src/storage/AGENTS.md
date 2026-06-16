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
- `fs.ts` → defines the `PlannerFs` interface (exists/readText/writeText/writeTextAtomic/mkdirp/...) and `createNodeFs()`, its real Node implementation. `writeTextAtomic` writes to a temp file then `rename`s, so a crash mid-write never corrupts the target file. Every store (`state-store.ts`, `plan-store.ts`, `project-store.ts`, `task-store.ts`) takes a `PlannerFs` as its first argument so tests can substitute an in-memory fake.
- `json.ts` → `readJson`/`writeJson`/`readJsonIfExists` wrap `PlannerFs` with JSON parsing and `PlannerJsonError` on malformed content; `writeJson` always goes through `fs.writeTextAtomic`, so all JSON writes inherit the atomic-write guarantee.
- `ids.ts` → `createProjectId()` derives a stable, filesystem-safe project directory name from a project root path (sanitized basename + sha256 hash suffix); `sanitizeIdPart`/`sanitizePathIdPart`/`compactIdPart` are the shared sanitizers also used by `task-store.ts` for task IDs.
- `paths.ts` → pure path builders, no I/O: `createProjectStoragePaths` (project dir under the agent's extension storage), `createPlanStoragePaths` (plan dir + its markdown/JSON files), `createTaskStoragePaths` (task dir + task/tdd/refactor markdown). These are the single source of truth for storage layout — `project-resolver.ts`, `worktree-index.ts`, and every store module call into here rather than building paths inline.
- `plan-store.ts` → `initializePlanFiles` scaffolds a new plan's directory (creates `tasksDir`/`contractsBaselineDir`, writes empty request/goal/plan/discovery/questions/decisions/verify markdown placeholders) and saves `plan.json`; `readPlanRecord`/`updatePlanRecord` are the read/update API runtime uses for `PlanRecord`. Distinct from `state-store.ts`, which owns `state.json` (runtime/transition data) rather than `plan.json` (static plan metadata).
- `project-store.ts` → owns `project.json` per project (one project can have many plans). `ensureProjectRecord` creates-if-missing; `setActivePlan`/`upsertProjectPlanSummary` are the only mutators — `setActivePlan` is how the extension tracks which plan is "current" across sessions.
- `task-store.ts` → `upsertTaskArtifacts` writes both `task.json` (`TaskRecord`) and a rendered `task.md` (objective/scope/acceptance criteria/contract chain/forbidden areas/domain details sections) from the same input, and touches `tdd.md`/`refactor.md` placeholders if absent. `updateTaskStatus` is the only place `TaskRecord.status` changes. Task IDs are validated through `sanitizeIdPart` from `ids.ts` to guarantee they're safe path segments.
- **Who writes state:** only `updatePlanState` in `state-store.ts` writes `state.json`. Runtime tools pass a reducer function. Nothing else writes state directly.
- **Who reads state:** `runPlannerOrchestrator` in `runtime/orchestrator.ts` loads state and packages it as `preflight.context`. All runtime tools receive state through the orchestrator context, never by reading storage directly.
- **Schema change blast radius:** adding a field to `PlanStateRecord` requires: (1) `schema.ts` type, (2) `createInitialPlanState` default, (3) `state-store.ts` normalization, (4) tests. Missing any one of these breaks resume for existing plans.
- **Layering:** `fs.ts` (I/O primitive) → `json.ts` (JSON framing) → `paths.ts` (layout) → `*-store.ts` (record-level read/update API) → `runtime/` (orchestration). Lower layers never import from higher ones.
<!-- pi-code-planner:contracts:end -->

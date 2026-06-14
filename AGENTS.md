<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
Root routing memory for pi-code-planner. Use this file to choose the project domain before reading source.

### Parent
- `(root)`

### Child Index
- `src/AGENTS.md`: TypeScript extension source, runtime state machine, tools, storage, settings, sessions, and worktrees.
- `instructions/AGENTS.md`: Bundled model-facing stage instructions synced into planner storage.
- `.github/AGENTS.md`: CI, release, labeler, and GitHub automation.

### Stable Contracts
- `planner_status` is the model-facing source of truth for stage, step, allowed tools, and persisted artifacts.
- Planner work happens in one isolated worktree per plan; raw git is forbidden while the planner is active.
- Durable planner memory belongs in AGENTS.md managed blocks. Non-AGENTS context files are read-only imports.

### Read First
- `README.md`
- `src/AGENTS.md`
- `instructions/AGENTS.md`

### Do Not Touch Unless
- Do not change stage names, tool names, artifact names, or package metadata without updating tests, docs, and release notes.
- Do not add broad new workflow stages when a small gate, instruction, or wrapper can enforce the behavior.

### Domain Details
- The package is a Pi extension with `pi.extensions` pointing at `src/index.ts`.
- Runtime behavior should be deterministic where possible; stochastic model behavior is constrained through persisted artifacts and wrappers.
- **Data flow:** `src/storage/` owns all JSON read/write and state normalization → `src/runtime/` reads storage via `runPlannerOrchestrator` (preflight context) → `src/runtime/status.ts` formats the prompt surface the model sees → `src/runtime/workflow-tools.ts` validates exit gates before each step transition.
- **Instructions flow:** `instructions/defaults/` markdown files are loaded by `src/instructions/manager.ts` and injected into compact boundaries and idle wake-ups; they are the model's stage-specific memory after compaction.
- **Contract flow:** `src/runtime/contracts.ts` scans/reads/writes AGENTS.md files in the worktree → contract state is persisted in `state.json` via storage → `planner_status` surfaces summaries and guidance to the model.
- **Git flow:** `src/git/` provides a runner used by runtime git wrappers; raw git is blocked during active plans to prevent worktree drift.
<!-- pi-code-planner:contracts:end -->

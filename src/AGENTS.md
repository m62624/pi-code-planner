<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
Source domain for the Pi extension implementation. Route to narrower AGENTS.md files before editing runtime, storage, or settings code.

### Parent
- `../AGENTS.md`

### Child Index
- `runtime/AGENTS.md`: Planner state machine, tool execution, status text, timers, stuck/debug/refactor/doubt/contracts/skills.
- `storage/AGENTS.md`: JSON schemas, project/plan/task stores, paths, state normalization, worktree index.
- `settings/AGENTS.md`: Global/project settings schema, defaults, validation, and merge order.

### Stable Contracts
- `src/index.ts` registers commands, tools, events, and Pi integration points; shared behavior should live in focused runtime/storage modules.
- Public tool schemas must remain strict and stable for resumed sessions.
- Tests live next to implementation as `*.test.ts` and are excluded from npm package files.

### Read First
- `index.ts`
- `guard/tool-policy.ts`
- `runtime/status.ts`
- `storage/schema.ts`

### Do Not Touch Unless
- Do not bypass planner wrapper policy from command or tool handlers.
- Do not use session-bound stale contexts after `ctx.switchSession`; use the replacement context.

### Domain Details
- Most extension work starts in `src/index.ts`, then moves to a runtime/storage helper once behavior needs tests.
- Keep model-facing strings explicit: local models need exact next actions, allowed wrappers, and blocked reasons.
- **Connection map:** `index.ts` → registers tools/commands → calls into `runtime/` executors → which call `storage/` readers/writers → which persist to `state.json`/`plan.json`. Settings flow: `settings/` → loaded by `runtime/orchestrator.ts` → affect gate policies and status formatting.
- **Cross-domain dependency:** `runtime/contracts.ts` reads AGENTS.md files via `storage/fs.ts` and writes contract summaries into `state.json` via `storage/state-store.ts`. Changes to storage schema (PlannerContractsState) break contracts.ts state reads.
- **Guard layer:** `guard/tool-policy.ts` is checked in `index.ts` before any tool reaches runtime. Changes to allowed tool lists require updating both the guard and `stage-behavior.ts` expectedTools.
<!-- pi-code-planner:contracts:end -->

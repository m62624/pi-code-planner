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
- `git/AGENTS.md`: Git shell wrapper (GitRunner), branch naming, worktree add/remove, planner branch ops.
- `guard/AGENTS.md`: Tool call policy, git command interception, project mutation safety checks.
- `instructions/AGENTS.md`: Stage/step → instruction file routing, defaults sync, user append merge.
- `session/AGENTS.md`: Pi session file creation, handoff between sessions, resume candidate discovery.
- `worktree/AGENTS.md`: Plan worktree lifecycle, path resolution, gitignore registration.
- `project-local/AGENTS.md`: Gitignore rule management for planner-owned paths.
- `vrf/AGENTS.md`: elenchus premise templates, template sync/routing, and the deterministic SDD compilers (spec/coverage/tdd-coverage → VRF).

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
- `index.ts` → Pi extension entry point; registers commands, tools, and events, and wires `guard/tool-policy.ts` in front of every tool call before it reaches `runtime/`.
- `index.tool-visibility.ts` → computes which tools are visible/hidden to the model for the current state (separate from whether a tool call is *allowed*, which `guard/tool-policy.ts` decides); read by `index.ts` when building the tool list for a turn.
- `constants.ts` → two package-wide constants, `EXTENSION_NAME` and `SCHEMA_VERSION`; bump `SCHEMA_VERSION` only alongside a real persisted-schema migration in `storage/schema.ts`.
- `public-api.ts` → barrel re-export of the full public surface (types + functions) across every domain — git, guard, instructions, project-local, runtime, session, settings, storage, worktree. Adding an export here without a corresponding domain change is a smell; every new domain export usually needs an entry added here too.
- Most extension work starts in `src/index.ts`, then moves to a runtime/storage helper once behavior needs tests.
- Keep model-facing strings explicit: local models need exact next actions, allowed wrappers, and blocked reasons.
- **Connection map:** `index.ts` → registers tools/commands → calls into `runtime/` executors → which call `storage/` readers/writers → which persist to `state.json`/`plan.json`. Settings flow: `settings/` → loaded by `runtime/orchestrator.ts` → affect gate policies and status formatting.
- **Cross-domain dependency:** `runtime/contracts.ts` reads AGENTS.md files via `storage/fs.ts` and writes contract summaries into `state.json` via `storage/state-store.ts`. Changes to storage schema (PlannerContractsState) break contracts.ts state reads.
- **Guard layer:** `guard/tool-policy.ts` is checked in `index.ts` before any tool reaches runtime. Changes to allowed tool lists require updating both the guard and `stage-behavior.ts` expectedTools.
<!-- pi-code-planner:contracts:end -->

<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
Settings domain for defaults, settings.json validation, merge order, and effective settings shown to users and agents.

### Parent
- `../AGENTS.md`

### Child Index
- (none)

### Stable Contracts
- Settings merge order is defaults, global settings, then project settings.
- `worktree` and `compact` are captured when a plan is created; runtime settings are read while planner runs.
- Metadata language settings affect human-facing generated text only.

### Read First
- `schema.ts`
- `manager.ts`
- `settings.test.ts`

### Do Not Touch Unless
- Do not add a setting without default, validation, merge behavior, README documentation, and tests.
- Do not let project settings partially corrupt nested defaults; nested settings need explicit merge behavior.

### Domain Details
- `schema.ts` → defines the `PlannerSettings` type and `DEFAULT_PLANNER_SETTINGS`, the canonical defaults object every merge layer falls back to.
- `manager.ts` → `loadEffectivePlannerSettings` is the source of truth for current values and setting source labels; merges defaults → global `settings.json` → project `settings.json`.
- `paths.ts` → `createPlannerSettingsPaths()` derives `globalSettingsJson` (under `extensionDir`) and `projectSettingsJson` (under `projectLocalDir`) from `storage/paths.ts`; `manager.ts` reads both paths in merge order.
- **Who reads settings:** `runtime/orchestrator.ts` calls `loadEffectivePlannerSettings` on every planner tool call — settings are loaded fresh, not cached in state, so project-level overrides apply immediately.
- **Settings blast radius:** `contracts.*` settings affect `runtime/contracts.ts`; `idle.*` and `timer.*` affect `runtime/idle-watchdog.ts` and `runtime/timer.ts`. Changing a setting key or type requires: `schema.ts` type, `manager.ts` merge, `DEFAULT_PLANNER_SETTINGS` default, tests, and README table.
<!-- pi-code-planner:contracts:end -->

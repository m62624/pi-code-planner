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
- `DEFAULT_PLANNER_SETTINGS` is the canonical defaults object.
- `loadEffectivePlannerSettings` is the source of truth for current values and setting source labels.
<!-- pi-code-planner:contracts:end -->

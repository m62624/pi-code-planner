<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
Instructions domain: stage/step routing to instruction files, syncing defaults to disk, and merging user-authored append files. Determines what system prompt text the model receives per stage and step.

### Parent
- `../AGENTS.md`

### Child Index
- (none)

### Stable Contracts
- Instruction files are keyed by `InstructionKey` (stage+step combinations defined in `schema.ts`).
- Three layers per key: defaults (built-in), global append (user's `~/.pi/`), project append (`.pi/pi-code-planner/`). Merged in that order.
- Defaults are synced to disk on plan create/resume so users can inspect and override them.

### Read First
- `schema.ts`
- `routing.ts`
- `manager.ts`

### Do Not Touch Unless
- Do not add a new stage/step without adding its `InstructionKey` to `schema.ts` and a default file in `defaults.ts`.
- Do not change the merge order (defaults → global → project) without updating `manager.ts` and tests.

### Domain Details
- `schema.ts` → defines `InstructionKey` union and `INSTRUCTION_KEYS` array; source of truth for valid keys.
- `routing.ts` → `getInstructionRoutingForState()` maps current `{stage, step}` to file paths; called by `runtime/orchestrator.ts` before each AI call.
- `manager.ts` → `syncInstructionFiles()` writes defaults to disk; `loadInstructionContent()` reads and merges all three layers.
- `defaults.ts` → inline default markdown strings for every key; changing these changes what models read.
- **Who calls this domain:** `runtime/orchestrator.ts` → `routing.ts` → `manager.ts` on every planner tool invocation to build the system prompt context.
<!-- pi-code-planner:contracts:end -->

<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
Runtime domain for planner stages, model-facing status, tool wrappers, timers, recovery, debug/stuck flow, contracts, skills, and accepted-plan finalization.

### Parent
- `../AGENTS.md`

### Child Index
- (none)

### Stable Contracts
- Stage and step order is strict; recovery is the only flow that may resume into another valid non-recovery position.
- Runtime gates must never allow wrappers outside the current stage/step policy.
- Artifacts are the durable truth after compact; chat memory is advisory only.
- `planner_contract_upsert` may write AGENTS.md only. Other context files are read-only imports.

### Read First
- `status.ts`
- `stage-behavior.ts`
- `workflow-tools.ts`
- `orchestrator.ts`
- `contracts.ts`

### Do Not Touch Unless
- Do not change lifecycle transitions without updating `state-machine.ts`, `state-transition.ts`, `workflow-tools.ts`, tests, and instructions.
- Do not add a new planner tool without updating guard policy, tool visibility expectations, status/instructions, and tests.

### Domain Details
- `status.ts` is the primary prompt surface for local models.
- `workflow-tools.ts` enforces exit gates for steps that need durable proof.
- `contracts.ts` implements the DOX-like local contract scanner/parser/upsert flow.
<!-- pi-code-planner:contracts:end -->

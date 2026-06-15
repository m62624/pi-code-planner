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
- Do not add or re-scope a planner tool without updating BOTH allowlists that gate it: the guard policy (`guard/tool-policy.ts` `STEP_ALLOWED_TOOLS`) AND the stage behavior (`stage-behavior.ts` `expectedTools`). Both gates must pass for a tool to be usable at a step; if the guard allows a tool the behavior gate omits, the model is blocked at runtime (a deadlock when no fallback exists). The two gates are composed only on the normal `allow_stage_machine` path (`orchestrator-gate.ts`); the broken/user-decision/compact states bypass the behavior gate and the guard returns a fixed set, so a step-scoped tool must never leak into those sets. Both halves are enforced by `tool-gating-invariant.test.ts` across the full flag matrix (debug on/off, broken, user-decision, compact). Also update tool visibility expectations, status/instructions, and tests.

### Domain Details
- `status.ts` is the primary prompt surface for local models; it reads `PlanStateRecord` from the orchestrator and formats step rules, contract summaries, and guidance lines.
- `workflow-tools.ts` enforces exit gates: each step's finish is blocked unless required artifacts/sections exist and the worktree is clean.
- `contracts.ts` implements DOX-like local contract flow: scans AGENTS.md files → routes chains → reads → upserts → validates. Contract state (summaries, chains, touchedFiles) lives in `PlannerContractsState` inside `state.json`.
- `stage-behavior.ts` defines per-step policy tables (allowed tools, commit policy, compact policy, required gates). These are the source of truth for `orchestrator-gate.ts` checks.
- `orchestrator.ts` runs preflight (reads storage, loads git reality, checks context) and is called by every planner tool before it executes.
- `idle-watchdog.ts` reads `state.activeTaskId` and `state.step` → sends follow-up wake-up if no activity for `idle.timeoutMinutes`. Depends on step being `running` and not in a blocked/compact/user-wait state.
- **Key dependency chain:** tool call → `index.ts` → `guard/tool-policy.ts` → `runtime/<tool>.ts` → `runPlannerOrchestrator` (reads storage + git) → executes → `updatePlanState` (writes storage). Any tool that skips `runPlannerOrchestrator` bypasses all stage/step/gate checks.
<!-- pi-code-planner:contracts:end -->

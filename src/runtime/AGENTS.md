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
- Reasoning fuel is tone-only: its level changes only the directive the model reads, never an allow/block decision. The only hard floors stay on named terminal defects (a CONFLICT verdict, an un-CONSISTENT gate). Enforced by `fuel-never-blocks.invariant.test.ts`.

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
- **Key dependency chain:** tool call → `index.ts` → `guard/tool-policy.ts` → `runtime/<tool>.ts` → `runPlannerOrchestrator` (reads storage + git) → executes → `updatePlanState` (writes storage). Any tool that skips `runPlannerOrchestrator` bypasses all stage/step/gate checks.
- **Dual-gate invariant:** a tool is only callable at a step if it is in BOTH `guard/tool-policy.ts` `STEP_ALLOWED_TOOLS` AND `stage-behavior.ts` `expectedTools`. `orchestrator-gate.ts` composes the two on the normal `allow_stage_machine` path only; broken/user-decision/compact states bypass the behavior gate, so step-scoped tools must never leak into those fixed sets. Enforced end-to-end by `tool-gating-invariant.test.ts`.

**State machine & gating** — own `PlanStateRecord.stage`/`step`/lifecycle, decide what runs next.
- `state-machine.ts` → pure transition functions (`startPlannerStep`, `advancePlannerStep`, `completePlannerStep`, `blockPlannerStep`, `failPlannerStep`, `retryPlannerStep`, `enterPlannerRecovery`, `resumePlannerAfterRecovery`, compact transitions) and `PlannerStateMachineError`; the only place that mutates stage/step legality.
- `state-transition.ts` → `PlannerStateTransition` union + `applyPlannerStateTransition`, the single chokepoint that calls into `state-machine.ts` and then `storage/state-store.ts` `savePlanState`; gated by `preflight.ts` `checkPlannerPreflightToolAllowed`.
- `stage-behavior.ts` → per-(stage,step) policy tables: `PlannerProjectAccess`, `PlannerBehaviorAction`, `expectedTools`, commit/compact policy. Source of truth consumed by `orchestrator-gate.ts` and `status.ts`.
- `orchestrator.ts` → `runPlannerOrchestrator`/`checkPlannerOrchestratorToolAllowed`: runs preflight (storage + git reality + instruction routing), then the lifecycle/behavior gates, before any tool body executes. Every `*-tools.ts` file in this domain calls it first.
- `orchestrator-gate.ts` → `filterPlannerWrapperToolsForLifecycle`/`checkPlannerWrapperToolForLifecycle`: applies `lifecycle.ts` decision + `stage-behavior.ts` behavior to narrow the guard's allowed-tool list down to what's actually usable right now.
- `lifecycle.ts` → `decidePlannerLifecycleNext`: maps `PlannerRuntimeAction` (from `planner-runtime.ts`) + state machine position to a `PlannerLifecycleAction` (`inspect_recovery`, `ask_user_decision`, `compact_pending`, `start_step`, `finish_step`, …). Drives `status.ts` guidance and `orchestrator-gate.ts` filtering.
- `planner-runtime.ts` → `evaluatePlannerRuntimeReality`: decides `allow_stage_machine` vs `require_recovery`/`require_user_decision`/`require_compact`/`no_active_plan` from `ActivePlanContextStatus` + `PlannerGitReality`. Feeds `lifecycle.ts`.
- `preflight.ts` → `runPlannerPreflight`/`checkPlannerPreflightToolAllowed`: assembles `PlannerPreflightResult` (active plan context, git reality, instruction routing, runtime decision) — the single read pass every tool depends on before deciding anything.

**Contracts / DOX** (`contracts.ts`) — implements the AGENTS.md contract flow: scans AGENTS.md/context files → routes chains → reads → upserts → validates (`parsePlannerContractMarkdown`, `formatPlannerContractBlock`, `validateContractReferences`). Contract state (summaries, chains, touchedFiles) lives in `PlannerContractsState` inside `state.json`. `workflow-tools.ts` calls `validateContractCheckCompleted`/`validateDiscoveryContractRouting` from here to gate step completion, and `status.ts` calls `formatPlannerContractsStatus` to surface it to the model.

**Plan & task lifecycle tools** — model-facing tool handlers that read/write `PlanRecord`/`TaskRecord`/`PlanStateRecord`.
- `plan-tools.ts` → create/improve a plan: syncs bundled instruction defaults, creates the plan branch (`git/branches.ts`), initializes plan files/state (`storage/plan-store.ts`, `storage/schema.ts` `createInitialPlanState`).
- `task-tools.ts` → `planner_task_upsert`: writes task artifacts via `storage/task-store.ts` `upsertTaskArtifacts`, echoes the canonical schema via `artifact-echo.ts`.
- `active-plan.ts` → `readActivePlanContext`: resolves the currently active plan/state/project records into one `ActivePlanContext`; read by almost every other file in this domain (preflight, recovery, timer, dashboard, plan-naming-adjacent tools).
- `accepted-plan.ts` → finalize flow: exports the accepted plan to the output branch (`git/planner-ops.ts`), writes the Pi session handoff dir (`session/handoff.ts`), produces `AcceptedPlanPreview`.
- `plan-naming.ts` → pure validation/generation helpers for plan titles/descriptions/ids (`validatePlannerPlanTitle`, `validatePlannerPlanDescription`); no I/O.
- `goal-tools.ts` → goal/discovery submission tools; validates naming via `plan-naming.ts`, advances the state machine, updates `storage/project-store.ts` plan summary.

**Artifacts** — the durable, structured markdown files tools write under the plan/task directories.
- `artifact-tools.ts` → generic submit handlers for `planner_plan_submit`/`planner_discovery_submit`/`planner_tdd_submit`/`planner_summary_submit`; merges TDD sections via `tdd-form.ts`.
- `artifact-utils.ts` → `appendPlannerSection`: shared atomic "append a `## Heading` section to a markdown file" helper used by several tool files.
- `artifact-echo.ts` → `formatArtifactEcho`/`formatCanonicalSchemaHint`: appends a canonical-schema-vs-written-output comparison to every strict tool's result so the model can self-correct formatting.

**Recovery / debug / stuck / doubt / refactor review flows** — non-happy-path tool families, all gated through `orchestrator.ts` like normal tools.
- `recovery.ts` → `inspectPlannerRecovery`: detects `PlannerRecoveryIssue`s (external commits, dirty worktree, missing managed branch) by comparing `git-state-sync.ts` reality against state.
- `recovery-manager.ts` → `resumePlannerRecovery`: applies a recovery resume decision, calling back into `state-machine.ts` to land on a valid non-recovery position (the only flow allowed to do so, per Stable Contracts).
- `recovery-tools.ts` → `planner_recovery_inspect`/`planner_recovery_resume` tool wrappers around the two files above.
- `debug-tools.ts` → `planner_debug_strategy/probe/result/cleanup`; tracks debug attempts under a per-attempt dir and exposes `assertNoPlannerDebugArtifactsBeforeCommit` (called by `git-tools.ts` before any commit) and `formatDebugStatusLines` (called by `status.ts`).
- `stuck-tools.ts` → `planner_report_stuck`: snapshots a stuck attempt, can hand off into `debug-tools.ts` `initializePlannerDebugSession`.
- `doubt-review.ts` → pure schema/validation for the doubt-review verification protocol (`DoubtFindingStatus`, `DoubtProofLevel`, `validateDoubtReviewAgainstVerificationProtocol`); `status.ts` calls `extractVerificationProtocolCommands` from here.
- `doubt-tools.ts` → `planner_doubt_review` tool wrapper around `doubt-review.ts`.
- `refactor-review.ts` → pure schema/validation for the structured refactor review form (required sections, `REFACTOR_REVIEW_CATEGORIES`, `RefactorDecision`).
- `refactor-tools.ts` → `planner_refactor_review` tool wrapper around `refactor-review.ts`.

**SDD gates (spec-driven development)** — the deterministic verifier loop: the model authors structured artifacts, compilers in `vrf/` turn them into VRF, the elenchus engine judges, and `workflow-tools.ts` hard-gates on the verdict.
- `elenchus-engine.ts` → thin lazy loader for the `elenchus-wasm` engine (`runElenchusCheck` with a sandboxed IMPORT resolver); degrades to a typed failure if the wasm is missing.
- `elenchus-tools.ts` → `planner_elenchus_check` (free-form, model-authored programs) + the shared `last-check.json` record (`ElenchusLastCheckRecord`, with `gate`/`sourceHash` for gate runs and a `repeat` counter that `writeElenchusLastCheck` increments on identical gate re-runs — the gate-thrash friction signal).
- `spec-tools.ts` → `planner_spec_submit`: validates and persists `spec.json`/renders `spec.md` via `storage/spec-store.ts`; snapshots the previous version to `spec.prev.json` (change-request audit trail).
- `gate-tools.ts` → `planner_gate_check` (`spec_consistency` | `plan_coverage` | `tdd_coverage`): loads durable artifacts, runs the matching deterministic compiler from `src/vrf/`, executes the engine, writes `coverage.md` sections + `last-check.json` (verdict + sha256 of the compiled source), and translates every machine gap into a concrete action or a ready-to-ask user question. Takes NO program — gate VRF is never hand-written (REQ-12).
- `behavior-tools.ts` → `planner_behavior_upsert`: the per-task behavior board (`storage/behavior-store.ts`), the `planned → red → green` test-first toggle ladder. The write is a MERGE, so `computeBehaviorBoardNudges` guards the two silent traps: an identical resubmit is named a no-op (else the model loops on the same board), and any in-scope owned REQ no behavior cites is named on the write itself (the same gap `tdd_coverage` would later block on). Both are nudges in the success text, never blocks — the board is already saved.
- Hard gates live in `workflow-tools.ts` (`validateSpecGatePassed`, `validatePlanCoverageGatePassed`, `validateTddCoverageGatePassed`): a gate step only advances on a CONSISTENT run whose `sourceHash` still matches the artifact on disk; legacy plans/tasks without the artifact degrade gracefully (REQ-11).

**Reasoning fuel** — a tone-only nudge toward the engine where a real interacting-condition web is on the table, computed entirely from the planner's own artifacts and records (never the engine's report). See the `fuel-never-blocks` Stable Contract above.
- `reasoning-fuel.ts` → pure math: `computeReasoningFuel({warrantedWeb, coverage, stale, friction})` (null when nothing warrants the engine), plus the warranted-web collectors (branches/spec-constraints/shared-surfaces) and the engagement/friction readers over `ElenchusLastCheckRecord`. No I/O, no store, no engine.
- `reason-context.ts` → `loadStepReasoningFuel`: assembles the current step's fuel by loading only the planner's own artifacts (spec constraints at consistency_check, task branches at the execution reasoning steps, shared task surfaces at doubt_review). The one bridge both the reason tool and `status.ts` call.
- `reason-directive.ts` → `renderReasoningDirective`: the tone ladder (silent when null, quiet ≥70, top-deficit in 30–69, directing below 30 or on any friction). Templated, never generative.
- `reason-tools.ts` → `planner_reason` (assert/retract/recheck over the living `vrf/world-store.ts`): returns the verdict + the engine's raw output verbatim + the fuel directive, and writes a model-authored `last-check.json` so fuel credits the engagement. Gated exactly like `planner_elenchus_check`.
- Surfacing: the fuel directive is rendered in `status.ts` (the `## Reasoning Fuel` section) AND on the tail of an applied workflow transition via `status.ts` `formatTransitionReasoningFuelTail`, which the tool dispatcher (`index.ts`) appends to `planner_finish_step`'s result — so the model meets the nudge in the drive loop it actually reads, not only on a rare `planner_status`. The dispatcher imports this from the surfacing layer (`status.ts`), never a fuel module, so the `fuel-never-blocks` invariant holds; `workflow-tools.ts` only passes `planPaths` through as data.

**TDD** — the structured pre/post-implementation evidence form.
- `tdd-evidence.ts` → field/section name constants for the pre-implementation proof contract, post-implementation counterexample review, and merge-scope audit; no logic.
- `tdd-form.ts` → `TDD_SECTIONS` (canonical order) + `mergeTddMarkdown`/`renderTddSection`, used by `artifact-tools.ts` to assemble/merge the TDD artifact.

**Git sync** — keeps `PlanStateRecord` consistent with actual repo state.
- `git-state-sync.ts` → `inspectPlannerGitReality` (branch/head/dirty/conflicts snapshot) and `runSyncedPlannerGitMutation`/`syncStateAfterPlannerGitMutation`, the only place that pairs a git mutation with a state write so they can't drift.
- `git-tools.ts` → task/refactor branch create+switch+merge tool wrappers (`git/branches.ts`, `git/planner-ops.ts`); calls `debug-tools.ts` `assertNoPlannerDebugArtifactsBeforeCommit` before any commit-bearing operation.

**Status / UI / dashboard** — everything the model or the human sees.
- `status.ts` → `getPlannerStepRule`: the primary prompt surface for local models; assembles step rules, contract summaries (`contracts.ts`), debug status (`debug-tools.ts`), verification protocol (`doubt-review.ts`), allowed tools (`orchestrator-gate.ts`), and active skills (`skill-library.ts`) into the guidance the model reads every turn.
- `dashboard-model.ts` → pure data/rendering layer for the TUI dashboard (stage sequence, palette-free formatting); unit-testable without a terminal.
- `dashboard.ts` → interactive `Component` that injects a real theme/palette and terminal size into `dashboard-model.ts`; reads `active-plan.ts` for live state.
- `chat-view.ts` → pure transcript projection (`projectSessionEntries`/`renderTranscript`) for the chat pane, consumed by `dashboard.ts`.
- `next-step-hint.ts` → labels a state-machine target as forward/backward/fix using `STAGE_ORDER`, read by `status.ts` and user-commands to phrase "what's next" hints.
- `user-commands.ts` → slash-command handlers (`planner_get_plan_list`, `planner_rename`, …) that read/write `PlanRecord`/`ProjectRecord` directly (outside the orchestrator gate, since these are human-invoked, not model tool calls).
- `user-command-ui.ts` → `PlannerCommandUi`-driven interactive helpers (`selectPlannerPlanId`) layered on top of `user-commands.ts` for prompts that need a picker/confirm.
- `about.ts` → builds the `planner_about`/settings-explainer text from `SettingDescriptor`s + `contracts.ts` basenames; pure presentation.

**Timers / watchdog** — background wake-ups outside the tool-call path.
- `timer.ts` → `PlannerTimerRuntimeState` + reconcile loop; reads `active-plan.ts`, gated by `index.tool-visibility.ts` `isPlanActive`, writes `PlannerTimerState` via `storage/state-store.ts`.
- `idle-watchdog.ts` → reads `state.activeTaskId`/`state.step` → emits a follow-up wake-up message if no activity for `idle.timeoutMinutes`; only fires for `IDLE_EXECUTION_STEPS` while not in a `USER_WAIT_STEPS`/blocked/compact state.

**Misc**
- `compact.ts` → builds the system-instructions bundle injected after a context compact (`PLANNER_COMPACT_MARKER`/`PLANNER_SYSTEM_INSTRUCTIONS_HEADER`), pulling section content from `instructions/manager.ts`.
- `compact-eta.ts` → pure empirical ETA for the compaction indicator. `estimateCompactionDuration` fits `T(x)=a+b·x` (weighted least squares, recency- and model-weighted; falls back to a through-origin rate model) over `storage/compact-timing-store.ts` history and reports a point ETA + band + variance (`cv` → `stable`/`noisy`/`single`/`none`). `compactionProgressFraction` drives an honest asymptotic bar that fills to a confidence-scaled target at the ETA and never reaches 100% before the real completion event. Wired in `index.ts` `registerPlannerCompactEvents`, gated by `isPlanActive`; the SDK does not stream summary generation, so this learned model is the only real progress signal.
- `skill-library.ts` → `planner_skill_create`/`planner_skill_update`: persists reusable skill markdown + a JSON index (`storage/json.ts`) keyed by source kind (`stuck`/`debug`/`doubt_review`/…); `status.ts` lists active skills from here.
- `question-tools.ts` → `planner_questions_submit`/`planner_questions_resolve`, the user-clarification loop; writes state via `storage/state-store.ts`.
- `workflow-tools.ts` → step-finish exit gates: blocks `finish_step` unless required artifacts/sections exist (via `contracts.ts`, `doubt-review.ts`) and the worktree is clean (`git-state-sync.ts` reality). The last checkpoint before `state-transition.ts` is allowed to advance.
<!-- pi-code-planner:contracts:end -->

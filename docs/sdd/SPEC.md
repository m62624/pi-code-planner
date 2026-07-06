# pi-code-planner — SDD Layer (Phase 2 of deep integration)

> Status: **DRAFT / in progress** — this is the living planning artifact for the
> SDD upgrade. It is written spec-first (numbered requirements with stable IDs)
> so we dogfood the very discipline the feature adds. It is a durable
> mini-artifact: it survives an auto-compact because it lives on disk, so after
> a compaction we resume from this file, not from chat memory.
>
> When a section is settled, mark it **DECIDED**. Open questions live in
> §9 and are driven down together, not guessed.

## 1. Purpose

Turn pi-code-planner from a planner that *narrates* intent ("do it roughly like
this") into a machine that practices **real Spec-Driven Development**: the LLM is
forced to author a checkable specification, elicit the missing details from the
user, and prove — through elenchus — that the plan and the work discharge that
spec with no dropped requirement and no orphan work. The goal is to make the
agent behave like an architect, not an order-taker.

Two capabilities, together:

1. **A spec as the source of truth** — a first-class artifact of numbered
   requirements, acceptance criteria, non-goals, constraints, and assumptions,
   sitting between raw intent (`goal.md`) and the plan (`plan.md`).
2. **elenchus as the verifier of that spec** — the spec is systematically
   *compiled* into VRF premises so the engine checks internal consistency,
   requirement coverage, absence of orphan tasks, and acceptance provability;
   and every gap the engine reports becomes a concrete **question to the user**.

## 2. The boundary (DECIDED)

- **elenchus stays a frozen kernel.** No SDD vocabulary leaks into the DSL. The
  proof-kernel arc (`PROVE`, `HENCE … FROM`, `FOR EACH … MENTIONED`,
  `TOTAL … ON`, `TRY … FOR`, `PREFERS … OVER`) is expressively complete for SDD.
  If a genuinely *logical* primitive turns out missing during template work,
  that — and only that — is a candidate for the kernel; software-engineering
  concepts (requirements, tasks, traceability) never are.
- **The SDD layer lives entirely in pi-planner**: a spec artifact + a spec→VRF
  compiler (new VRF templates) + new stage/step gates + the gap-elicitation
  loop. SDD is *another consumer* of the kernel, exactly like today's
  `plan-consistency` / `tdd-gate` templates — which validates the original
  decision to separate the abstract core from this Pi extension.

### 2.1 Numbers and data in the spec (DECIDED)

The spec inevitably contains data and numbers; VRF is propositional and has no
arithmetic (the SMT fence). Spec data splits cleanly:

- **Structural / relational data** (which task covers which requirement, which
  enumerated cases exist, named individuals like `retry_3`) → native VRF:
  `FACT`, sets, `TOTAL … ON`, `FOR EACH … MENTIONED`.
- **Numeric magnitude** (`latency < 200ms`, `at most N`, `budget ≥ cost`) → the
  number never enters VRF. The LLM (prover) computes the predicate and asserts a
  **boolean leaf** (`latency_within_budget`) as a `FACT`; elenchus checks only
  the *logical consequences* and that the boolean is not contradicted downstream
  — catching the LLM being inconsistent with itself, which is the real bug.

Techniques to keep structure around magnitudes without crossing the fence:
ordinal bands (`fast < ok < slow < timeout`), bounded cardinality by enumeration
(the `exactly one of` trick generalized to small named k-of-n), and
relations-as-data (`covers(budget, cost)` fed as FACT pairs). Genuine arithmetic
(unbounded N, `sum = 100%`) stays outside as an asserted boolean.

### 2.2 Constrain the checkable, free the inexpressible (DECIDED — elenchus-verified)

The gate constrains the model's *planning* through elenchus **only for what VRF
can express**. What is genuinely inexpressible — taste, "the UX feels calm",
open-ended judgment, real arithmetic — must be routed to human judgment as prose
in `spec.md` with a recorded rationale (**the freedom valve**), never forced into
`spec.json`. **Over-formalizing is itself a weak spot**, not diligence.

This is not a preference; it was verified mechanically with elenchus (three
models in scratchpad):

- **No valve, honest** — force every requirement to be formalized: an
  inexpressible one leaves the gate at `WARNING` forever (the gate can never be
  satisfied — a deadlock).
- **No valve, model games it** — if the model falsely asserts `formalized` to
  escape, elenchus catches the lie as a `CONFLICT` (`formalized` ∧
  `NOT vrf_expressible`).
- **Freedom valve** — an inexpressible requirement becomes
  `deferred_to_freedom` → `addressed` and the gate reaches `CONSISTENT`.

So the model must **understand what elenchus is for**: the checkable web of
interacting conditions, not everything. Coverage counts a requirement as
discharged when it is *either* formalized-and-consistent *or*
deferred-to-freedom-with-rationale (REQ-15). A legitimate `acceptanceAtom`
omission is exactly a freedom-valve deferral; an *unexplained* omission is not
allowed (REQ-14).

## 3. Baseline — what already exists (do not rebuild)

Established by reading the current source; this is the ground the SDD layer
builds on.

- **8 stages**, strict ordered steps: `init → intake → discovery → planning →
  execution → finalize → done` plus `recovery`
  (`src/storage/schema.ts` `PLANNER_STAGE_STEPS`).
- Each step is a `PlannerStageStepBehavior`
  (`src/runtime/stage-behavior.ts`): `projectAccess`, `actions`,
  `requiredArtifacts` / `updatedArtifacts`, `requiredGates`, `expectedTools`,
  `commitPolicy`, `compactPolicy`. **Dual-gate invariant**: a wrapper tool is
  usable only if it is in *both* this behavior list *and*
  `guard/tool-policy.ts` `STEP_ALLOWED_TOOLS` — enforced by
  `tool-gating-invariant.test.ts`.
- **State machine** (`src/runtime/state-machine.ts`) advances strictly to the
  next computed position; only `recovery` may jump arbitrarily.
- **Artifacts today**: `request.md` (raw request) → `goal.md` (intent) →
  `discovery.md`, `questions.md`, `decisions.md` → `plan.md` (how) →
  `task.json` / `task.md` → `tdd.md`, `refactor.md`, `verify.md` →
  `final_summary.md`; plus `project.json` / `plan.json` / `state.json` and
  `contracts/manifest.json`.
- **elenchus is already wired** as the `planner_elenchus_check` wrapper, present
  in: `discovery/scan_project_structure`, `planning/consistency_check`,
  `execution/write_tdd_plan`, `execution/contract_check`,
  `finalize/doubt_review`, `recovery/repair_or_resume`. There are 7 bundled VRF
  templates in `vrf/defaults/`. **But the checks are ad-hoc**: the model writes
  the VRF by hand; there is no systematic spec that mechanically produces the
  premises.
- **Compaction survival is already built**: per-stage `compact_*` steps persist
  durable `.md` artifacts + `state.json`; post-compact the model must call
  `planner_status` and resume from disk (`src/runtime/compact.ts`). The spec
  artifact plugs straight into this — it is just another durable pointer.

## 4. Requirements

Stable IDs; tasks will later trace to these (§7 coverage check).

### Spec artifact
- **REQ-1** — A first-class **spec artifact** exists (`spec.md`, and a machine
  half `spec.json`), authored after intent + discovery and before the plan. It
  holds: requirements (each with a stable ID, a statement, an acceptance
  criterion, a priority), non-goals, constraints/invariants, and assumptions
  (the asserted boolean/data leaves).
- **REQ-2** — Every requirement has a stable, human-visible ID (`REQ-n`) reused
  across `spec.json`, the plan, task files, and VRF facts, so traceability is by
  identity, not fuzzy text match.
- **REQ-3** — Non-goals are explicit and first-class: a requirement the user
  declares out of scope is recorded as a non-goal, and coverage never demands a
  task for it.

### Spec → VRF compilation (the verifier)
- **REQ-4** — A deterministic **spec→VRF compiler** emits premises from
  `spec.json` (new bundled template(s) in `vrf/defaults/`), covering at least:
  - **spec-internal-consistency**: the requirements + constraints are not
    mutually contradictory (elenchus `CONFLICT`).
  - **requirement-coverage**: every in-scope requirement is discharged by at
    least one task — `TOTAL <covers> ON REQUIREMENTS`; a missing witness is a
    dropped requirement.
  - **no-orphan-task**: every task traces to ≥1 requirement (`HENCE … FROM`);
    orphan work surfaces as an ORPHAN/gap.
  - **acceptance-provability**: each acceptance criterion is `PROVE`-able from
    the plan + assumptions, or is explicitly flagged as unproven.
- **REQ-5** — The compiler is pure/deterministic and unit-tested by running its
  output through the real wasm engine (extend `src/vrf/vrf.test.ts`), so a
  regression in the premises fails CI.

### Gap-driven user communication
- **REQ-6** — Every gap elenchus reports (`UNDERDETERMINED`, missing witness,
  unproven acceptance, spec `CONFLICT`) is turned into a **concrete question**
  routed through the existing questions/decision machinery — the engine's gaps
  are the interview script, not the model's whim.
- **REQ-7** — The flow **cannot leave the spec phase** until the spec compiles
  to `CONSISTENT` and every in-scope requirement is either covered or
  explicitly deferred/de-scoped by a recorded user decision. This is the
  architect-forcing gate.

### Lifecycle / integration
- **REQ-8** — Spec authoring integrates into the stage/step machine without
  breaking the dual-gate invariant or existing tests (new steps/tools added to
  both `stage-behavior.ts` and `tool-policy.ts`; behavior matrix stays green).
- **REQ-9** — The spec artifact is compaction-durable: it is listed in the
  relevant `compact_*` step's `requiredArtifacts`, and the post-compact resume
  message points at it, so the spec always survives auto-compact.
- **REQ-10** — On a change request (`done/handle_change_request`) the spec is
  the thing that is amended and re-verified; requirement diffs across spec
  versions must not silently drop a requirement (orchestration keeps both
  versions and re-runs coverage).

### Backward compatibility (hard constraint)
- **REQ-11** — **Existing plans must not break.** Specifically:
  - `TaskRecord.requirements` is optional and defaults to `[]` on load, so
    legacy `task.json` parses unchanged (schema 4-point change:
    type + `createInitial` default + `normalizePlanState`/task-store normalize
    default + a test).
  - Inserting the `spec` stage must keep every persisted `state.json` valid: old
    stage/step strings still exist, and the new stage is reachable only via the
    retargeted `discovery/enter_planning`, so a legacy plan already past that
    point never enters it.
  - `planning/consistency_check` coverage must **degrade gracefully when
    `spec.json` is absent** (legacy plan): it skips the coverage gate instead of
    hard-blocking a plan that predates the spec artifact. New plans always have
    `spec.json`, so the gate bites for them.
  - The tool-gating invariant matrix and all existing tests stay green (REQ-8).

### Robustness for a local model (weak-spot hardening)
The gate must survive a *weaker* local model, not just a strong one.
- **REQ-12** — **The model never hand-writes gate VRF.** It authors the
  structured `spec.json` (validated: enum priorities, `REQ-n` ids, atom names)
  and the deterministic compiler (REQ-4) emits guaranteed-valid VRF. This moves
  the DSL's sharp edges (invented syntax, typo'd atoms, `_`-vs-space) off the
  model — the single biggest hardening lever.
- **REQ-13** — Each `assumption` (boolean leaf, §2.1) carries **evidence**: its
  `statement` must cite the source/command that established the predicate. A leaf
  with no evidence is flagged at `elicit_gaps` and re-checked at
  `finalize/doubt_review`. (The checkability ceiling cannot be fully closed —
  elenchus trusts the leaf — but ungrounded leaves must not pass silently.)
- **REQ-14** — An omitted `acceptanceAtom` requires a recorded reason. The only
  legitimate reason is a freedom-valve deferral (§2.2); an unexplained omission
  is rejected at `verify_spec`, so a lazy model cannot dodge every `PROVE`.
- **REQ-15** — `verify_spec` runs the spec check with `BIDIRECTIONAL` and the
  `FOR EACH … MENTIONED` schema, to defeat the **vacuous-`CONSISTENT`** trap: a
  near-empty spec that is trivially consistent surfaces as `UNDERDETERMINED`
  (many models fit) rather than false-green, and every requirement subject is
  reached by the schema. Coverage counts a requirement discharged iff formalized
  -and-consistent OR deferred-to-freedom-with-rationale.

## 5. New / changed artifacts

| Artifact | Role | Compaction-durable |
|---|---|---|
| `spec.md` | Human-readable spec: requirements, non-goals, constraints, assumptions | yes (REQ-9) |
| `spec.json` | Machine spec (schema §5.1) — the compiler source | yes |
| `coverage.md` | elenchus verdict: spec-consistency (spec stage) + coverage/orphan (planning) + the gaps that became questions | yes |
| new `vrf/defaults/*.vrf` | spec→VRF template(s) for REQ-4 checks | shipped |

### 5.1 `spec.json` schema (DECIDED)

```jsonc
{
  "requirements": [
    { "id": "REQ-1", "statement": "...", "acceptance": "...",
      "acceptanceAtom": "req1_satisfied",   // OPTIONAL VRF atom → PROVE target
      "priority": "must" | "should" | "could", "inScope": true }
  ],
  "nonGoals": ["..."],
  "constraints": [
    { "id": "CON-1", "statement": "...", "kind": "invariant" }
  ],
  "assumptions": [
    { "id": "ASM-1", "atom": "latency_within_budget", "negated": false,
      "statement": "measured 187ms < 200ms budget" }   // boolean leaf (§2.1)
  ]
}
```

- `assumptions` are the **boolean leaves** of §2.1: a VRF `atom` + `negated` + a
  human `statement` explaining the predicate the LLM computed outside. No numbers
  enter VRF — only the atom name and the explanation.
- `acceptanceAtom` is **optional in v1**: present → the compiler emits
  `PROVE <acceptanceAtom>` and it must be derivable (`HENCE … FROM` assumptions
  / task-produced facts); absent → acceptance stays a human-checked text string.
  This keeps the strict gate meaningful without forcing full-derivation authoring
  in the first cut.
- `constraints` participate in spec-consistency alongside `requirements`.

### 5.2 `TaskRecord.requirements` (DECIDED, backward-compatible)

Add an **optional** field `requirements?: string[]` (`REQ-n` ids) to `TaskRecord`
(`src/storage/schema.ts`). The coverage compiler reads it from each `task.json`
to emit `TOTAL … ON REQUIREMENTS` + no-orphan facts — traceability by identity,
not fuzzy text. Because it is optional and defaulted to `[]` on load, **legacy
`task.json` files without it still parse** (REQ-11).

## 6. Stage / step integration (DECIDED)

Spec authoring needs *both* the goal *and* discovery context (to write
acceptance criteria grounded in the real codebase), so it sits after
`discovery` and before the plan. **Decision: a dedicated `spec` stage** between
`discovery` and `planning` — cleanest and most honest to SDD, worth the
state-machine change. User-facing artifact term is **"spec"** ("contract" is
already taken by file-boundary contracts, so it is avoided).

New `PlannerStage`: `spec`, inserted so the strict flow becomes
`… → discovery → spec → planning → …`. `discovery/enter_planning` is retargeted
to enter `spec/draft_requirements`; a new `spec/enter_planning` enters
`planning/read_context`.

### 6.1 `spec` stage steps

| step | projectAccess | actions | required → updated artifacts | expected tools | notes |
|---|---|---|---|---|---|
| `draft_requirements` | planner_artifacts | write_artifacts | `discovery.md` → `spec.md`, `spec.json` | `planner_spec_submit` (new) | author REQ-n, non-goals, constraints, assumptions |
| `elicit_gaps` | user_communication | ask_user | `spec.md` → `questions.md`, `decisions.md` | `planner_questions_submit`, `planner_questions_resolve` | questions come from §6.2 gaps |
| `compile_spec_vrf` | planner_artifacts | write_artifacts | `spec.json` → spec `.vrf` | `planner_spec_submit` | deterministic spec→VRF (REQ-4) |
| `verify_spec` | planner_artifacts | run_checks, write_artifacts | `spec.json`, `.vrf` → `coverage.md` | `planner_elenchus_check` | **blocking gate** (§6.2) |
| `compact_spec` | none | compact | `spec.md`, `spec.json`, `coverage.md` → `state.json` | `planner_request_compact`, `planner_complete_compact` | compaction-durable (REQ-9) |
| `enter_planning` | none | state_transition | `state.json` → `state.json` | `planner_finish_step` | requires new gate `spec_verified` |

New behavior gate: **`spec_verified`** — set only when `verify_spec` reports the
spec `CONSISTENT` and every in-scope requirement covered-or-de-scoped; it is the
`requiredGate` on `spec/enter_planning`, mirroring `plan_verified` on
`planning/enter_execution`.

New wrapper tool: **`planner_spec_submit`** — added to both `stage-behavior.ts`
`expectedTools` and `tool-policy.ts` `STEP_ALLOWED_TOOLS` (dual-gate invariant,
REQ-8).

### 6.2 The blocking gate (DECIDED — strict from v1)

The REQ-4 checks split across **two** gates, because requirement *coverage*
needs tasks, and tasks are authored in `planning` (`split_tasks` /
`write_task_files`) — they do not exist yet in the `spec` stage:

- **`spec/verify_spec`** (before the plan): spec-internal-consistency
  (`CONFLICT` on contradictory requirements/constraints) + acceptance
  well-formedness. No tasks needed. Blocks `spec/enter_planning`
  (`spec_verified`).
- **`planning/consistency_check`** (the existing slot, upgraded): requirement
  **coverage** (`TOTAL <covers> ON REQUIREMENTS` — a missing witness is a
  dropped requirement) + **no-orphan-task** (each task `HENCE … FROM` its
  requirements). Reads `requirements: ["REQ-n"]` from each `task.json`. Blocks
  `planning/enter_execution` (`plan_verified`).

Both are **hard gates from the first version**, not advisory: any
`CONFLICT`, `UNDERDETERMINED`, missing coverage witness, or unproven acceptance
**stops** the flow — those verdicts become questions (loop back to
`elicit_gaps` in the spec stage, or to plan/task revision in planning) — until
the spec is `CONSISTENT` and every in-scope requirement is covered or explicitly
de-scoped by a recorded user decision. This is the architect-forcing mechanism;
the LLM cannot skip detail to reach the next stage.

## 7. Verification (this feature's own gates)

1. `npm run build && npm test` green; the tool-gating invariant matrix stays
   green (REQ-8).
2. New spec→VRF templates run through the real wasm engine in `vrf.test.ts` and
   assert the expected verdict per fixture (REQ-5).
3. An end-to-end fixture: a spec with a deliberately dropped requirement →
   coverage check reports the exact missing REQ-n and blocks (REQ-7); adding the
   task clears it.
4. Compaction test: the spec artifacts appear in the compact step's
   `requiredArtifacts` and in the resume pointers (REQ-9).
5. Release version bump follows the semver rule already recorded (a new
   user-facing capability = minor).

## 8. Non-goals

- **NG-1** — No arithmetic / SMT in elenchus. Numbers stay boolean leaves (§2.1).
- **NG-2** — No new elenchus keywords for SDD. The kernel is frozen (§2).
- **NG-3** — Not rebuilding discovery, TDD, contracts, recovery, or the git
  worktree flow — the SDD layer sits *around* them, reusing what exists.
- **NG-4** — Not auto-answering the user's design questions: the loop *surfaces*
  gaps and forces detail; the human still decides scope and trade-offs.

## 9. Gate model — mechanically verified (elenchus)

The whole gate/transition system was expressed in VRF and checked with the
elenchus engine (0.15.0), not by hand. The reproducible models live in
[`models/`](models/) (`sdd-core.vrf` = the machine; `p1…p6` = scenarios;
`gate-*` = the freedom-valve proof); [`models/README.md`](models/README.md) has
the expected-verdict table.

**What the engine established:**

- An **honest path to `done` exists and is consistent** for *both* requirement
  kinds — expressible → formalize (`p2`, CONSISTENT) and inexpressible →
  defer-with-rationale (`p1`, CONSISTENT).
- A **lazy or gaming model is structurally blocked**: an unaddressed requirement
  cannot pass the spec gate (`p3`, blocked), and a faked `formalized` on an
  inexpressible requirement is caught as a CONFLICT (`gate-gamed`).
- **Coverage must be a planning-stage gate, never a spec-stage gate.** Coupling
  it into spec verification forms a cycle — spec → tasks → planning → spec — that
  **deadlocks**, because tasks do not exist yet at the spec stage (`p4`,
  WARNING). This is the mechanical proof behind the §6.2 split.
- The coverage gate (`TOTAL covered_by ON requirements`) **names any dropped
  requirement** and clears when a covering task is added (`p6`); a legacy plan
  (empty requirement set) passes vacuously.

**Placement rules that follow (insert to avoid deadlock):**

1. `spec/verify_spec` gate = spec-consistency + "every in-scope requirement
   *addressed*" (formalized-and-consistent OR deferred-with-recorded-rationale).
   It must **not** reference coverage/tasks.
2. `planning/consistency_check` gate = coverage (`TOTAL`) + no-orphan, evaluated
   only **after** tasks exist.
3. The freedom valve is gated on a **recorded rationale** — this is what stops a
   lazy model from deferring everything (modeled as `req rationale_recorded` in
   `sdd-core.vrf`).
4. Any gate whose satisfaction depends on an artifact produced by a *later* stage
   is a deadlock cycle — keep every gate's inputs from the current or an earlier
   stage.

## 10. Open decisions — ALL RESOLVED

- ~~**OD-1** — Stage shape~~ → **DECIDED**: dedicated `spec` stage (§6).
- ~~**OD-2** — `spec.json` schema~~ → **DECIDED**: §5.1.
- ~~**OD-3** — task→requirement traceability~~ → **DECIDED**: optional
  `TaskRecord.requirements` (§5.2, REQ-11).
- ~~**OD-4** — gap loop advisory vs blocking~~ → **DECIDED**: blocking gate from
  v1 (§6.2).
- ~~**OD-5** — template reuse / where checks live~~ → **DECIDED**: spec compiler
  ships NEW templates; premises consumed at two gates — spec-consistency at
  `spec/verify_spec`, coverage at `planning/consistency_check`; `plan-consistency`
  is not subsumed (§6.2).
- ~~**OD-6** — naming~~ → **DECIDED**: "spec".

Planning of the SDD/VRF layer is complete — ready to move from spec to a build
plan (tasks tracing to REQ-1…REQ-11).

## 11. Log

- `feat/sdd-planning-spec` created; baseline architecture surveyed; boundary
  (§2) and numbers-as-leaves (§2.1) decided; this draft written.
- OD-1 / OD-4 / OD-6 decided: dedicated `spec` stage, blocking gate from v1,
  name "spec". §6 filled in with the concrete stage/steps, the `spec_verified`
  gate, and the `planner_spec_submit` wrapper.
- Caught a missed possibility: coverage cannot run before tasks exist → REQ-4
  checks split across `spec/verify_spec` (consistency) and
  `planning/consistency_check` (coverage). Resolves OD-5; §6.2 corrected.
- OD-2 / OD-3 decided: `spec.json` schema §5.1 (assumptions = boolean leaves,
  optional `acceptanceAtom`); optional `TaskRecord.requirements` for traceability.
- Backward compatibility promoted to a hard constraint (REQ-11): old plans /
  `task.json` must not break; coverage degrades gracefully without `spec.json`.
- Weak-spot hunt with elenchus itself (scratchpad, engine 0.15.0 verified):
  proved the freedom valve is structurally necessary (no valve → WARNING
  deadlock; gaming → CONFLICT; valve → CONSISTENT). Added §2.2 (constrain the
  checkable, free the inexpressible) and local-model hardening REQ-12
  (structured spec.json, never hand-written VRF), REQ-13 (assumptions carry
  evidence), REQ-14 (no unexplained acceptanceAtom omission), REQ-15
  (BIDIRECTIONAL + MENTIONED to defeat vacuous-CONSISTENT).
- Expressed the WHOLE gate/transition system in VRF and checked all
  combinations (models/ + §9): honest path to done consistent for both
  requirement kinds; laziness/gaming blocked; coverage-in-spec-gate proven a
  deadlock cycle; coverage gate names dropped requirements. Derived the four
  placement rules in §9. Committed the reproducible models under models/.
- **IMPLEMENTED** (branch `feat/sdd-planning-spec`), with these recorded
  deviations from the letter of this spec:
  - §6.1: the spec stage's exit step is **`finish_spec`**, not
    `enter_planning` — step names are globally unique across stages
    (`state-machine.ts` `buildStepToStageMap` throws) and discovery already
    owns `enter_planning`, which REQ-11 forbids renaming.
  - §6.1: the separate `compile_spec_vrf` step was **folded into the gate
    tool** (`planner_gate_check`): compilation is deterministic code, not a
    model step, so a dedicated state-machine position added nothing.
  - Gates are enforced through the `last-check.json` mechanism
    (gate + verdict + sha256 of the compiled source artifact, checked in
    `validateWorkflowExit`), not through the descriptive `requiredGates[]`
    lists — those were never an enforcement mechanism in the runtime.
  - `SpecConstraint` gained an optional machine half
    (`relation: implies | exclusive | oneof | atleast` over boolean-leaf
    atoms): without it, a validated spec compiled to a vacuously-green
    program; the relation web is where the engine finds real contradictions
    (CONFLICT) and unestablished atoms (WARNING → elicit-gaps questions).
  - The plan-coverage program is self-contained (no bundled template):
    elenchus `SET`s do not cross files, so the sets + witness pairs + TOTAL
    lines must live in one generated file.
- New requirements added during implementation (execution-phase coverage,
  the "toggle board"):
  - **REQ-16** — every task carries a behavior registry
    (`tasks/<id>/behaviors.json`): one `BHV-n` per observable behavior
    (happy/edge/error/concurrency, optional REQ-n traceability) with the
    mechanical status ladder `planned → red → green`; `planned → green` is
    rejected (test-first by data). Maintained via `planner_behavior_upsert`.
  - **REQ-17** — the `tdd_coverage` gate compiles the registry into
    `TOTAL … ON behaviors` witness tables and hard-gates execution:
    leaving `write_tests` requires every behavior red-witnessed, leaving
    `run_final_tests` forward requires green; the engine NAMES each
    uncovered behavior. Legacy tasks without a registry skip the gate.
- Change requests (REQ-10): `done/handle_change_request` now forks to
  `spec/draft_requirements` for plans with a spec (amend → re-verify →
  re-cover; `planner_spec_submit` snapshots the prior version to
  `spec.prev.json`), keeping `planning/read_context` for legacy plans.

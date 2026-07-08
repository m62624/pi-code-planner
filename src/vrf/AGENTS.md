<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
elenchus/VRF domain: the bundled premise-template library, its sync/routing plumbing, the deterministic SDD compilers that turn durable planner artifacts into engine-checkable programs, and the plan's living logical world (an accumulating registry of model-asserted statements).

### Parent
- `../AGENTS.md`

### Child Index
- (none)

### Stable Contracts
- Gate VRF is never model-authored (SPEC.md REQ-12): everything the hard gates run is emitted by the deterministic compilers here from validated artifacts (`spec.json`, `task.json[]`, `behaviors.json`). Free-form model programs go through `planner_elenchus_check` only.
- Compiler output is byte-deterministic (inputs sorted by id; the engine itself is deterministic), so snapshot tests are safe.
- Every compiler is unit-tested through the REAL wasm engine (`runtime/elenchus-engine.ts`), never a mock — a premise regression must fail CI with the engine's own verdict.
- `VRF_TEMPLATE_NAMES` (schema.ts) must list every file in `vrf/defaults/`; a project override at `.pi/pi-code-planner/vrf/<name>.vrf` beats the bundled default.
- elenchus `SET`s do not cross files: a compiler whose program needs sets (coverage, tdd-coverage) must emit a fully self-contained file, not a template import.
- For model-authored programs (`world-store.ts`, `runtime/elenchus-tools.ts`) the planner reads only the verdict code and hands the engine's raw output on verbatim — it never parses the report body (orphans/beliefs/derivations). The narrow, bounded parse of `status`/`conflicts`/`warnings`/`goals` in `runtime/gate-tools.ts` is legitimate only because those are compiler-authored programs whose atom vocabulary the planner owns.

### Read First
- `schema.ts`
- `routing.ts`
- `spec-compiler.ts`

### Do Not Touch Unless
- Do not add SDD/software-engineering vocabulary to the elenchus kernel — the engine stays a frozen logical core; this layer is just another consumer.
- Do not change a bundled template without re-running its green/CONFLICT/WARNING fixtures in `vrf.test.ts` — templates are vetted premise libraries; consumers only err at the fact level.

### Domain Details
- `schema.ts` → `VRF_TEMPLATE_NAMES` (the closed bundled-template list) + sync types.
- `defaults.ts` → loads `vrf/defaults/*.vrf` from the package.
- `manager.ts` → `syncVrfTemplatesToPlan`: content-hash idempotent copy into `<planDir>/elenchus/templates/`, honoring project overrides.
- `routing.ts` → `getRecommendedVrfTemplates(stage, step)`: which template a step reaches for by default (always "use it or record not_applicable", never "decide whether it applies").
- `paths.ts` → template path/import helpers.
- `spec-compiler.ts` → `compileSpecConsistency`: `spec.json` → the spec_consistency gate program. Imports `vrf/defaults/spec-consistency.vrf` (the engine-verified freedom-valve arc from `docs/sdd/models/`), fully closes every requirement subject (FACT/NOT, never omitted) so `CHECK BIDIRECTIONAL` noise is zero, emits assumptions as `<atom> holds` leaves, constraint relations as PREMISE blocks, acceptance atoms as advisory PROVE goals. Claim is bound through the bare `spec_gate.spec_verified` VAR port.
- `coverage-compiler.ts` → `compilePlanCoverage`: `spec.json` + each `TaskRecord.requirements`/`dependsOn` → self-contained witness tables. `TOTAL covered_by ON requirements` always names each dropped requirement. The orphan dimension has two modes: **dependency mode** (any task declares `dependsOn`) emits a justification web — a task is not orphan if it discharges a requirement OR a discharging task transitively depends on it (`depends_on` facts + `CLOSE depends_on TRANSITIVE` for reachability AND cycle rejection + `self_justified`/`dep_justified` RULEs + `every_task_justified` PREMISE); a cycle is found in TS (`dependencyCycle`) so the gate reports it cleanly instead of an engine crash. **Legacy mode** (no `dependsOn` anywhere) keeps the old `TOTAL traces ON tasks`, grandfathered so resume never breaks. Deferred requirements and non-goals never enter the requirement set — a freedom-valve deferral IS the discharge. This is what dissolves the borrowed-REQ trap: an infra task owns no requirement, so tdd_coverage never demands a behavior exercise one.
- `tdd-coverage-compiler.ts` → `compileTddCoverage`: `behaviors.json` → per-phase witness tables (`has_red_test` at write_tests, plus `has_green_test` at run_final_tests; green still totals red so test-first stays visible).
- `world-store.ts` → the living world: a persistent registry (`<planDir>/elenchus/world/world.json`) of model-asserted statements compiled into per-domain files (acyclic layer order spec → discovery → plan → task_* → scratch) and re-checked as a whole. Observations carry a file anchor; a stale hash demotes `FACT`→`BELIEVES planner` at compile time. Runs scan the verdict and return the raw output — `WorldRunRecord` holds the verdict only, never the report. Consumed by `runtime/reason-tools.ts`.
- Consumers: `runtime/gate-tools.ts` (the only caller of the compilers), `runtime/elenchus-tools.ts` (free-form checks importing the templates), and `runtime/reason-tools.ts` (the living world).
- `vrf.test.ts` → the engine-backed harness: every template parses bare, reaches CONSISTENT on an honest green fixture, and yields CONFLICT/WARNING on violated/omitted duties.
<!-- pi-code-planner:contracts:end -->

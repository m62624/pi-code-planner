# SDD gate/transition models — mechanically verified with elenchus

These `.vrf` files express the SDD planner's gate and transition logic so the
whole system's consistency is checked by the elenchus engine, not by hand. They
are the reproducible proof behind `../SPEC.md` §6.2 and §12.

Run any file (requires `elenchus-cli` ≥ 0.15.0; imports resolve in file mode):

```sh
elenchus-cli p1-inexpr-defer.vrf
```

## Expected verdicts

| File | Scenario | Verdict |
|---|---|---|
| `sdd-core.vrf` | the machine: stage ordering, gates, freedom valve, coverage timing (library, imported) | — |
| `p1-inexpr-defer.vrf` | honest run: inexpressible requirement, deferred with rationale | **CONSISTENT** |
| `p2-expr-formal.vrf` | honest run: expressible requirement, formalized in VRF | **CONSISTENT** |
| `p3-lazy-unaddressed.vrf` | lazy: inexpressible, no rationale, not formalized | **blocked** (exit 1) — cannot reach planning |
| `p4-coverage-at-spec.vrf` | design mistake: coverage coupled into the spec gate | **WARNING** — deadlock (`blocked by tasks exist`) |
| `p6-coverage-quantified.vrf` | the real coverage gate: `TOTAL covered_by ON requirements`, r3 uncovered | **WARNING** — names r3 |
| `gate-naive.vrf` | force every requirement into VRF, honest | **WARNING** — deadlock |
| `gate-gamed.vrf` | force-formalize, model lies to escape | **CONFLICT** — the lie is caught |
| `gate-freedom.vrf` | the freedom valve | **CONSISTENT** |

## What they prove

- An honest path to `done` exists and is consistent for **both** requirement
  kinds (expressible → formalize, inexpressible → defer-with-rationale).
- A lazy/gaming model cannot reach the next stage: an unaddressed requirement
  blocks the spec gate; a faked `formalized` is caught as a CONFLICT.
- **Coverage must be a planning-stage gate, never a spec-stage gate** — coupling
  it into spec verification is a cycle (spec → tasks → planning → spec) that
  deadlocks, because tasks do not exist yet at the spec stage.
- The coverage gate mechanically names any dropped requirement and clears when a
  covering task is added. A legacy plan (empty requirement set) passes vacuously.

# pi-code-planner — std VRF library (Spec Two)

> Status: **DRAFT / in progress.** Companion to [`SPEC.md`](SPEC.md) (the SDD
> layer). This spec designs the *bundled, persistent* std library of VRF —
> the abstract "director" that steers any program, plus the composable LEGO
> bricks of engineering knowledge. Written spec-first (SL-n ids). Durable
> mini-artifact: resume from this file after an auto-compact.
>
> We design fully **before** release on purpose — this is the reasoning
> substrate every future plan will lean on, so it must fit **any genre** and a
> **small, not-very-smart model** that must still know its next move all the way
> to the end.

## 1. Purpose

Ship, inside the extension, a reusable VRF library that turns tacit engineering
expertise into an executable form. A model answers abstract TRUE/FALSE (and small
ordinal) questions about **goals, constraints, and hardware**, and the library
**directs**: it names the trade-offs being made, warns where you will pay, and
points at the mechanisms implied — without the model needing to *know* system
design. For a weak/local model the library is a prosthetic for knowledge it
lacks: it doesn't need to know CAP or homomorphic encryption; it answers "multi
region? data regulated?" and the library carries the theorem.

## 2. The epistemology — think in forms, not objects (DECIDED)

This is the soul of the library and the rule every file obeys.

- **Formal logic needs the *form*, not the *content*.** The library holds
  abstract *formulas* of engineering decisions (the shape of a trade-off, the
  structure of a gate), never genre-specific content. There is no "how to build
  YouTube" and no "web vs ML" baked in.
- **Content enters only through answers.** The concrete system (this YouTube DB,
  this collider controller) is supplied by the model's `PROVIDE`d port values.
  The library reasons over the form; the answers are the content.
- **Abstraction is what makes it universal.** Because it reasons in forms, one
  small library covers *every* genre — every system has goals, constraints, and
  hardware. Genre lives in the answers, not in files.
- **The exception clause (a freedom valve for forms).** Some decisions are
  irreducibly concrete — stripping the content out destroys the task's meaning.
  Those are handled directly by the model's judgment (as in `SPEC.md` §2.2), not
  forced into a form. Form-first is the default, not an absolute.

Epistemology teaches reasoning by *forms*, not concrete objects — so does this
library. (North star: the engine embodies the reasoning kernel; the model
supplies the particulars.)

## 3. Two systems — one a template, one LEGO (DECIDED)

The library is deliberately **not** folders-per-program-class. It is **one
maximally abstract director** plus a **flat set of composable bricks**.

| | **`core.vrf` — the director** | **LEGO bricks** |
|---|---|---|
| KIND | `template` | `brick` |
| Role | one abstract entry: goals + constraints + hardware → direction + trade-off warnings | one law / one concern each |
| Used by | you **answer** its ports and run it standalone | you **compose** via `IMPORT` + shared ports |
| Completeness | self-contained | incomplete alone |
| Analogy | a finished instrument | a resistor / transistor |
| Examples | `core.vrf`; the SDD gates (Spec One) | `cap`, `bottleneck`, `idempotency`, `security-ladder`, … |

Why the distinction matters (SL-1): all-templates → rigid silos, nothing
recombines; all-bricks → the model must self-assemble (too hard for a small
model). So: **few templates as entry points, many bricks as the knowledge, and
the director orchestrates which bricks to pull.** The model enters through the
director, which says "you need `cap` + `cache` + `security-ladder`", and snaps
them in. Every file is tagged `// KIND: template | brick` in its header.

## 4. Relationship to the SDD layer (Spec One)

- **The std library FEEDS the spec stage.** During `spec/draft_requirements` and
  `elicit_gaps`, the model runs the director + relevant bricks; their `DERIVED`
  direction and trade-off notes become `constraints` / `assumptions` in
  `spec.json`. Principled design during spec authoring.
- **Advisory, not binding — the crucial difference.** The director only *warns*
  ("you'll pay somewhere — think it through"); it never emits `CONFLICT`. Hard
  `CONFLICT` gates belong to the SDD layer (`verify_spec`, coverage). Two
  different roles: the std library *steers*, the SDD gates *enforce*.

## 5. The three vocabularies

- **Qualities you VALUE** — `speed`, `security`, `cost`, `efficiency`,
  `simplicity`, `scalability`, `reliability`, `flexibility`. Ranked, not
  boolean (§6). You cannot rank everything top — "can't sit on all chairs."
- **Characteristics the system HAS** — `read_heavy`, `untrusted_input`,
  `io_bound`, `growth_expected`, … Split `declared` vs `measured` (§7).
- **Mechanisms it IMPLIES** — `cache`, `shard`, `encrypt`, `shadow_table`,
  `homomorphic`, … Derived direction.

Laws map **(characteristics × ranked qualities) → mechanisms + warnings**.

## 6. Ordinal priority — advisory, never a restriction (DECIDED)

Priority does not forbid; it only *complicates*, and the only outputs that matter
are the **warning** and *what is worth thinking through*. The program cannot know
in advance where you will pay (cost vs cpu vs io — the algorithm isn't decided
yet), so it never asserts the outcome — it flags the tension and names candidates.

- Each quality is ranked into a tier: `ONEOF { critical, important, nice }`
  (ordinal, closed → a mistyped tier is a hard error).
- A known trade-off pair, both ranked high → **WARNING** that **clears only when
  the model records it considered** (a `_considered` port). Never a `CONFLICT`.
  You *may* rank everything `critical` — you just accrue a pile of "you'll pay
  here, think it through" warnings. That is "can't sit on all chairs" as
  *pressure*, not prohibition.
- A trade-off brick outputs candidate cost-axes, not a verdict: "speed+security
  ranked high → you will pay, likely in { cost | cpu | io | complexity } — which
  is unknowable now; think it through."
- A low-tier (`nice`) quality derives `do_simplest_now_<quality>` — do the simple
  thing, leave an extension point for later.

## 7. declared vs measured ports — the premature-optimization guard (DECIDED)

Every port is tagged `declared` or `measured`.
- **declared** — answerable from requirements (`read_heavy`, `regulated`).
- **measured** — the model must **compute/profile** to establish it
  (`cpu_bound`, `io_bound`, the real hotspot). Until measured it stays
  **UNKNOWN**, never guessed.

Direction rules hold a measured port as a **required antecedent**, so with no
measurement they don't fire and elenchus returns `UNDERDETERMINED` — "measure the
bottleneck before optimizing." Knuth's "premature optimization is evil", encoded:
the library refuses to recommend optimizing what is not proven to be the
bottleneck. A measured port is the boolean-leaf pattern — the model profiles,
recomputes, then asserts.

## 8. `core.vrf` — the director's variables (draft)

**Goals (ranked, `ONEOF {critical, important, nice}` each):**
`speed`, `security`, `cost`, `efficiency`, `simplicity`, `scalability`,
`reliability`, `flexibility`.

**Constraints (hard limits, `declared` boolean):**
`budget_tight`, `team_small`, `deadline_hard`, `regulated`, `must_reuse_legacy`,
`offline_required`.

**Hardware (resources):**
- `declared`: `gpu_needed`, `memory_constrained`, `network_constrained`,
  `storage_constrained`.
- `measured`: `cpu_bound`, `io_bound`, `memory_bound`, `network_bound`.

**Outputs (advisory, derived):**
- direction: `consider_security`, `consider_parallelism`, `consider_async`,
  `consider_scaling`, `consider_cache`, `consider_cost_control`.
- warnings: `tradeoff_<A>_<B>` (WARNING until `_considered`).
- simplification: `do_simplest_now_<goal>` (for `nice` goals).
- guard: measured bottleneck UNKNOWN + `speed` high → `UNDERDETERMINED`.

**Acknowledgement ports (clear a warning by having thought it through):**
`tradeoff_speed_security_considered`, `tradeoff_speed_cost_considered`,
`tradeoff_scalability_simplicity_considered`, …

## 9. LEGO brick catalogue (draft)

Each is `// KIND: brick`, reads shared ports, adds its own.

| Brick | Own ports | Derives |
|---|---|---|
| `cap` | `partition_possible`, `consistency ONEOF{strong,eventual,none}`, `availability_critical` | `availability_sacrificed` / warning |
| `bottleneck` | `cpu_bound`, `io_bound`, `memory_bound` *(measured)* | `consider_parallelism/async`; premature-opt guard |
| `idempotency` | `retries_possible` (async ∨ auto_recovery) | `idempotency_required` |
| `statelessness` | `stateful_compute`, `growth_expected` | `need_state_externalization` |
| `cache` | `read_heavy`, `latency_sensitive`, `consistency` | `consider_cache`, `invalidation_hard` |
| `cost` | `budget_tight` + heavy hardware | `cost_pressure` warnings |
| `security-ladder` | `data_sensitivity ONEOF{public,internal,confidential,regulated}`, `untrusted_input`, `insider_threat`, `compute_on_encrypted_needed` | ladder `auth → TLS → encryption_at_rest → field_encryption → shadow_table → homomorphic`; trade-off `homomorphic → cost_heavy, latency_heavy` |
| `reliability-ladder` | `availability_critical`, `data_loss_intolerable`, `partition_possible` | `replication → backup → failover` |
| `scaling-ladder` | `scale ONEOF{single,small,large,internet}`, `growth_expected`, `stateless_compute` | `vertical → horizontal → sharding` |

**Shared canonical port vocabulary** (byte-stable, tagged declared/measured;
consumed by several bricks + the director): `read_heavy`, `write_heavy`,
`latency_sensitive`, `untrusted_input`, `growth_expected`, `partition_possible`,
`consistency`, `data_sensitivity`, `stateless_compute`, …

## 10. Requirements

- **SL-1** — Two systems only: one abstract `core.vrf` **template** (director) +
  a **flat** set of composable **bricks**. No per-genre folders. Each file tagged
  `KIND: template | brick`.
- **SL-2** — **Form over content**: no genre-specific content in any file; all
  concreteness enters through answered ports (§2). Honor the exception clause.
- **SL-3** — Priority is **ordinal and advisory**: the director warns, never
  emits `CONFLICT` (§6).
- **SL-4** — Trade-off warnings **clear only on a recorded acknowledgement**
  (`_considered`), and name candidate cost-axes rather than a verdict.
- **SL-5** — Every port tagged `declared|measured`; measured ports enforce the
  **premature-optimization guard** via UNKNOWN → UNDERDETERMINED (§7).
- **SL-6** — One **canonical, byte-stable** shared port namespace; `ONEOF` closes
  every choice variable so a mistyped value is a compile error, not a silent atom.
- **SL-7** — The **director orchestrates** which bricks apply; the small model
  never has to self-assemble the library.
- **SL-8** — Bricks compose via `IMPORT` + shared ports; a brick is meaningful
  only in combination.
- **SL-9** — The library **feeds the SDD spec stage** (`DERIVED` → `spec.json`),
  and is **advisory**, strictly distinct from the binding SDD gates (§4).
- **SL-10** — Each file is **tested through the real wasm engine**; every law
  encodes a sourced **first principle**, not an unverified heuristic (a wrong
  premise steers wrong).
- **SL-11** — **Small-model usability**: answering the director's abstract
  questions, the model always has a defined next direction — to the end of the
  path.
- **SL-12** — **Any genre** is covered by the base pillars alone (goals /
  constraints / hardware), never by enumerating program classes.

## 11. Non-goals

- **NG-1** — No genre folders / domain packs in v1 (web, ML, embedded). The
  director + bricks stay abstract; domain packs, if ever, are a later layer.
- **NG-2** — No arithmetic / SMT. Magnitudes are boolean leaves / ordinal bands.
- **NG-3** — The director does not *decide* the architecture or predict the
  outcome; it steers and warns. Judgment stays with the model/human.
- **NG-4** — Not a replacement for the SDD gates; it informs them.

## 12. Open decisions

- **OD-1** — Goal set: keep `efficiency` and `flexibility`, or fold `efficiency`
  into `cost` and drop `flexibility`?
- **OD-2** — Tiers: is `ONEOF {critical, important, nice}` enough, or add
  `ignore`?
- **OD-3** — The **known trade-off pairs** must be enumerated by hand (first
  principles, not heuristics): which pairs, and each one's candidate cost-axes.
- **OD-4** — Brick catalogue: is the §9 set the right minimal spanning set — what
  to cut/add?
- **OD-5** — Where the shared port namespace physically lives (one `std/ports.vrf`
  of `VAR` declarations imported by all, vs each brick declaring its own).
- **OD-6** — How the director points at bricks mechanically (a `consider_<brick>`
  derived atom the orchestrator reads, vs the model choosing from the warnings).

## 13. Log

- Draft created on `feat/sdd-planning-spec`. Decisions carried in: two systems
  (template director + LEGO bricks); form-over-content epistemology; ordinal
  advisory priority (warn, acknowledge-to-clear, name cost-axes); declared vs
  measured ports + premature-optimization guard; flat `std/`, no genre folders;
  feeds the SDD spec stage, advisory not binding. Variable lists (§8) and brick
  catalogue (§9) are first drafts to prune (§12).

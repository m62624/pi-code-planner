# Analysis: Old pi-iterative-planner Architecture — What Worked, What Broke, What's Missing

## PART 1: How Git Worked in the Old Version

### 1.1 Git Branch Binding

Every plan created a dedicated git branch:
- `planner.plan()` → `git checkout -b plan-{uuid}` → new branch
- `planner.finish_step()` → `git add . && git commit -m "{output}"` → commit on plan branch
- `planner.fork()` → `git checkout -b {source_branch}-copy` → new branch from source
- `planner.switch()` → `git checkout {target_branch}` → switch to target branch

Git state was tracked in `GitState` object:
```typescript
interface GitState {
  current_branch: string;      // What branch we're on RIGHT NOW
  current_commit: string;      // HEAD commit hash
  last_plan_branch: string;    // What branch the plan EXPECTS
  last_plan_commit: string;    // What commit the plan EXPECTS
  has_uncommitted_changes: boolean;
}
```

### 1.2 Prompt Injection (Branch Mismatch Detection)

Before EVERY tool call, `checkGitBranch()` ran:
1. `git rev-parse --abbrev-ref HEAD` → current branch
2. `git rev-parse HEAD` → current commit
3. Compared with `last_plan_branch` and `last_plan_commit`
4. If mismatch → injected a WARNING into the LLM prompt

This was the "guard rail" — if the model accidentally switched branches, it got warned.

### 1.3 Commit Tracking Per Step

Each step in `steps.json` tracked:
```typescript
interface StepEntry {
  commit_before: string;  // Commit hash BEFORE this step
  commit_after: string | null; // Commit hash AFTER this step
}
```

When `finish_step()` was called:
1. `commitBefore = getCurrentCommit()` — snapshot current HEAD
2. `markStepExecuting(stepId, commitBefore)` — record in steps.json
3. Check `git diff` — if no changes → mark completed WITHOUT commit (no-op)
4. If changes exist → `git add . && git commit -m "{output}"` → record commit hash
5. `resetSoft(commit)` — reset HEAD to the new commit
6. `markStepCompleted(stepId, output, commit)` — mark done
7. Trigger `ctx.compact()` with step summary

### 1.4 The Commit Blocker

A `tool_call` hook blocked direct `git commit` commands:
```typescript
if (command && /git\s+commit/.test(command)) {
  return { block: true, reason: "Use planner.finish_step instead" };
}
```

This forced the model to use the extension's commit mechanism.

---

## PART 2: What Was Wrong — Architectural Failures

### 2.1 Compact After Each Step — This Was CORRECT ✅

**This was NOT a bug.** `ctx.compact()` after every completed atomic unit is a feature:

```
one work_item TDD cycle → finish_step() → commit/merge bookkeeping → ctx.compact("here's what was done") → read plan.md → continue
```

Why this is correct:
- Compact discards raw context but PRESERVES the summary in plan.md on disk
- Model's active window stays narrow — only current work item + plan.md
- Model doesn't carry the entire history of all previous steps
- Each step is atomic — compact forces clean boundaries after the unit is actually finished
- After compact: model reads plan.md (on disk) → sees what's done → knows what's next

This is the "working window" principle: keep active context small, persist everything to disk.

**Verdict:** Keep compact after each `finish_step`, but define `finish_step` as the end of exactly one completed atomic `work_item` (function, class, UI change, config change, migration, documentation unit, etc.). Never compact in the middle of that unit's local test/implement/verify loop. Add compact instructions: "here's what was done, what was verified, which commit/merge was produced, and where the summary is stored in plan.md."

### 2.2 The Linear Step Model Was Too Rigid

The old system had a linear DAG:
```
Step 1 → Step 2 → Step 3 → Step 4 → ...
```

But real development is NOT linear. When you're implementing one atomic `work_item`, you may need to:
1. Understand the interface
2. Write tests
3. Write implementation
4. Handle edge cases
5. Refactor

All of these are part of ONE atomic unit of work. But the old system encouraged splitting them into separate steps, each with its own commit, its own compaction, and its own context loss.

**The fix:** One `work_item` = one atomic unit. One successful `finish_step` = one committed/merged unit. No splitting inside the unit.

### 2.3 The Sync Mechanism Was Fragile

The `.sync` file tracked whether `plan.md` and `steps.json` were in sync:
- `""` — corrupted
- `"md_only"` — plan.md saved, steps.json not
- `"json_only"` — steps.json saved, plan.md not
- `"both"` — synced

This was overly complex. Every tool call had to check sync status, handle recovery, etc. The model often got confused about which file to update first.

**The fix:** Simplify. `steps.json` is the source of truth. `plan.md` is derived from it. No sync mechanism needed.

### 2.4 The Comprehension Budget Was Over-Engineered

The old system had:
- `current_clarity` (0-1 score)
- `phase_thresholds` (minimum clarity per phase)
- `total_questions_asked`
- `update_comprehension()` tool
- `shouldAskQuestions()` logic

This was supposed to force the model to self-assess before proceeding. But in practice:
- The model couldn't accurately self-assess
- The threshold math was opaque to the model
- It added cognitive load without improving outcomes

**The fix:** Replace with explicit stage instructions. DISCOVERY stage tells the model exactly what to analyze. TDD stage tells the model exactly what to test. No guessing.

### 2.5 The DAG System Was Unnecessary Overhead

The old DAG had:
- `ready_queue` — steps ready to execute
- `blocked_ids` — steps blocked by dependency failures
- `dirty_ids` — steps needing re-verification
- `pruneSubtree()` — mark descendants as pending on failure

This was designed for complex multi-step workflows with arbitrary dependencies. But for a single-model system:
- Dependencies are simple (step N depends on step N-1)
- Failures are handled by the TDD loop, not by the DAG
- The DAG added complexity without adding value

**The fix:** Simple sequential execution with a TDD loop. No DAG needed for the core flow.

### 2.6 The Phase Machine Was Too Complex

Old phases:
```
IDLE → DISCOVERY → PLAN → EXECUTE → [COMPACT | HYPOTHESIZE | COMPLETE]
                                              ↓              ↓
                                         BACKTRACK        (terminal)
                                             ↓
                                          EXECUTE (loop)

HYPOTHESIZE → ADAPT → EXECUTE (loop)
EXECUTE → DEBUG → EXECUTE (loop)
```

Too many phases, too many transitions. The model got confused about which phase it was in and what to do next. The `shouldTransition()` and `getRecommendedNextPhase()` functions were complex decision trees that the model couldn't reason about.

**The fix:** Simple, explicit stages with clear instructions. No auto-transition logic. The model decides what to do based on stage instructions.

---

## PART 3: The Old Ideas (What Was Good)

Despite the failures, the old system had some good ideas:

### 3.1 Git Branch Per Plan ✅
Each plan gets its own git branch. This is clean — you can `git log plan-xxx` to see the plan's history. This should be kept.

### 3.2 Plan as Disk-First ✅
Plans are stored on disk (plan.md + steps.json), not in memory. This means plans survive compaction. This should be kept.

### 3.3 Tool Call Hook for Git Commit Blocking ✅
Blocking direct `git commit` calls forces the model to use the extension's commit mechanism. This should be kept, but simplified.

### 3.4 Session Persistence ✅
Plans survive across sessions. When you restart, the extension loads the active plan from disk. This should be kept.

### 3.5 Pi Fork / Session Awareness ✅
Pi has its own fork/session history mechanism. The new extension should not ignore it. If a plan is active and Pi creates a fork, switches session history, or resumes a different branch of conversation, the planner must detect that event and bind the correct planner state and git branch to that Pi fork/session.

This is not the same thing as old user-facing `planner.fork`. The old manual fork tool can be removed or deferred, but the extension must eventually support Pi fork/session events as a first-class synchronization mechanism.

---

## PART 4: The New Architecture — Complete Rewrite

### 4.1 Core Philosophy

**One work_item = one atomic unit of work. One completed unit = one controlled commit/merge checkpoint.**

The new system is built around a simple principle: **isolate each atomic unit completely**. The model should never lose context mid-unit. Each unit goes through a well-defined local loop, then the extension records the result, commits/merges it, and compacts.

```
DISCOVERY → PLAN → WORK_ITEM_LOOP (Hypothesize/Test → Implement → Verify) → REFACTOR → API_CHECK → DOCUMENTATION → COMPLETE
```

The extension is a helper for a local model, not a replacement implementer. The model still writes code, tests, documentation, and fixes. The extension manages state, stage instructions, git branches, commit policy, recovery checkpoints, compaction prompts, and guard rails.

### 4.2 New Stage Pipeline

#### Stage 1: DISCOVERY

**Purpose:** Understand the project deeply enough that a smaller local model can work safely for hours without architectural drift.

**What happens:**
1. Model reads project structure (file tree, key files)
2. Model identifies:
   - Naming conventions (snake_case, camelCase, etc.)
   - Project structure (MVC, modular, etc.)
   - Existing patterns (error handling, testing, etc.)
   - Dependencies and their versions
   - API contracts (interfaces, types, etc.)
   - Available Pi SDK and TUI APIs relevant to the extension/task
   - Existing project-specific instructions and overrides
   - Questions that must be asked before implementation
3. Model writes findings to `plan.md` under `## Discovery` section
4. Model writes findings to `stages/discovery.md` (internal stage file)

**Critical:** NO `ctx.compact()` between DISCOVERY and PLAN. Context flows naturally.

**Transition to PLAN:** When model says "I understand the project, here's the plan."

#### Stage 2: PLAN

**Purpose:** Break the task into atomic `work_items`. A work item is the smallest unit that should keep context uninterrupted until it is working and verified.

**What happens:**
1. Model reads `plan.md` (from DISCOVERY) + user task
2. Model identifies all atomic units that need to be implemented. A unit can be a function, class, UI slice, config change, migration, documentation update, or other project-specific unit.
3. Model creates `stages/tdd_plan.json`:
   ```json
   {
     "target_branch": "plan-xxx",
     "work_items": [
       {
         "id": "unit_1",
         "kind": "function",
         "name": "validateEmail",
         "signature": "function validateEmail(email: string): boolean",
         "test_cases": ["valid_email", "invalid_email", "empty_string", "null"],
         "edge_cases": ["unicode_email", "very_long_email"],
         "depends_on": []
       },
       {
         "id": "unit_2",
         "kind": "function",
         "name": "hashPassword",
         "signature": "function hashPassword(password: string): string",
         "test_cases": ["normal", "short", "long", "special_chars"],
         "edge_cases": ["unicode_password", "empty"],
         "depends_on": ["unit_1"]
       }
     ]
   }
   ```
4. Model writes plan to `plan.md` under `## Plan` section
5. **NO `ctx.compact()`** — context flows to TDD

**Transition to TDD:** When model says "Here are all the atomic work items I need to implement."

#### Stage 3: TDD (Test-Driven Development)

This is the core execution loop. Each `work_item` goes through:

**3a. Create Child Plan**
- `git checkout -b plan-xxx-unit-N` (new branch from target_branch)
- Create child plan directory with:
  - `work_item.md` — exact scope, signature/API contract, and acceptance criteria
  - `test_requirements.md` — what tests to write
  - `stages/tdd.md` — stage instructions

**3b. Hypothesize (Fuzzing)**
- Model creates tests or verification checks FIRST (before implementation) when the unit is testable
- Tests cover:
  - ✅ Happy path (expected result)
  - ❌ Failure case (expected failure)
  - 📏 Absolute minimum (boundary)
  - 📏 Absolute maximum (boundary)
  - 🎲 Fuzzing (random edge cases)
- If the unit is not a pure function, the stage instructions define equivalent verification: UI checks, snapshots, CLI command output, migration dry-run, lint/typecheck, or docs validation
- Tests may be written as TODO stubs or failing assertions first — they should prove the missing behavior before implementation
- Each TODO/failing assertion includes a comment linking it to the current work item: `// TODO: implement unit_N (child branch: plan-xxx-unit-N)`

**3c. Implement**
- Model replaces TODO stubs with actual implementation
- Implementation matches the contract from `work_item.md`
- Model runs tests — they should PASS now
- If tests fail → model fixes implementation (not tests)
- The model does not directly commit. It calls `planner.finish_step` only after the unit is implemented and verified.

**3d. Verify**
- Model runs full test suite
- All tests pass → verify

**3e. Finish Step / Rewind (Cleanup)**
- **THIS IS THE KEY DIFFERENCE FROM OLD VERSION**
- The model calls `planner.finish_step`
- The extension validates git state, test/verification status, and dirty changes
- The extension creates the controlled commit on the child branch using configured commit style
- The extension switches back to `{target_branch}`
- The extension merges: `git merge --no-ff plan-xxx-unit-N` (merge into target)
- The extension deletes child branch: `git branch -D plan-xxx-unit-N`
- The extension deletes or archives child plan directory
- The extension records commit/merge hashes in `steps.json` and updates `plan.md`

**3f. Compact**
- NOW `ctx.compact()` is triggered — AFTER the entire TDD cycle
- Compact keeps: current work item's contract, verification results, commit/merge hashes, and next work item
- Compact discards: implementation details, intermediate thoughts
- Model reads updated `plan.md` to see what's next

**Transition:** Loop back to 3a for the next work item.

#### Stage 4: REFACTOR (Configurable Iterations)

**Purpose:** Improve code quality. Runs N times (configurable, default 3).

**What happens (each iteration):**
1. Model analyzes code in target branch
2. Model finds:
   - **Large functions** (>50 lines) → split into smaller functions
   - **Duplicate code** → extract to shared function/constant
   - **Magic numbers** → replace with named constants
   - **Inconsistent patterns** → align with project conventions
3. Model makes changes, runs tests
4. Model calls the planner commit/finalize path; extension commits: `refactor: {description}`
5. **`ctx.compact()`** — preserves improvements, discards details
6. Model reads updated `plan.md`

**Configurable:** In `settings.json`:
```json
{
  "instructions": {
    "discovery": "instructions/discovery.md",
    "plan": "instructions/plan.md",
    "tdd": "instructions/tdd.md",
    "refactor": "instructions/refactor.md",
    "api_check": "instructions/api_check.md",
    "documentation": "instructions/documentation.md",
    "commit_style": "instructions/commit_style.md"
  },
  "refactor": {
    "max_iterations": 5,
    "compact_after_each_iteration": true
  }
}
```

Settings are layered:
1. Built-in defaults shipped with the extension
2. Extension-level settings stored next to the installed extension
3. Project-level overrides under `.pi/{extension-name}/`

Project overrides can replace stage markdown files, commit style instructions, verification commands, and extra project-specific rules.

**Transition:** When `iteration_count >= max_iterations` OR model says "no more improvements."

#### Stage 5: API_CHECK

**Purpose:** Remove unused code, ensure API surface is clean.

**What happens:**
1. Model analyzes all exported functions/types
2. For each exported item:
   - Is it used anywhere in the codebase?
   - Is it part of the public API (exported in index.ts)?
   - Is it used in tests?
3. Model deletes:
   - Exported functions/types that are NOT used anywhere
   - Internal functions that are NOT used (dead code)
4. Model keeps:
   - All exported functions/types (even if not used — might be public API)
   - All test files
5. Model runs tests — should still pass
6. Model calls the planner commit/finalize path; extension commits: `chore: remove unused exports`

**Transition:** When model says "all unused code removed."

#### Stage 6: DOCUMENTATION

**Purpose:** Add documentation to all public functions.

**What happens:**
1. Model identifies all public (exported) functions
2. For each function:
   - JSDoc comment with description
   - Parameter descriptions
   - Return value description
   - Example usage
3. Model runs tests — should still pass
4. Model calls the planner commit/finalize path; extension commits: `docs: add JSDoc for public API`

**Transition:** When model says "documentation complete."

#### Stage 7: COMPLETE

**Purpose:** Final summary, statistics, cleanup.

**What happens:**
1. Model generates `plan.md` summary:
   - What was implemented (list of work items)
   - Test coverage summary
   - Git statistics (commits, lines changed, files modified)
2. Model runs final test suite
3. Model triggers final `ctx.compact()`
4. Model exits with: `Phase: COMPLETE`

---

### 4.3 New File Structure

```
~/.pi/agent/plans/{project-dir}/
├── branch_map.json              # Plan ↔ Git Branch mapping
├── current_plan.json            # Active plan UUID
├── {plan-uuid}/
│   ├── plan.md                  # Human-readable plan (title + sections)
│   ├── steps.json               # Step state (simplified — no DAG)
│   ├── state.json               # Runtime state (phase, active unit, Pi session/fork binding)
│   └── stages/                  # Stage-specific files
│       ├── discovery.md         # Discovery findings
│       ├── tdd_plan.json        # Work item list with contracts
│       ├── tdd.md               # TDD stage instructions
│       ├── refactor.md          # Refactoring state
│       ├── api_check.md         # API check results
│       └── documentation.md     # Documentation state
└── settings.json                # Optional extension-level/project-level effective settings snapshot
```

Instruction markdown is loaded from built-in defaults, then extension settings, then project `.pi/{extension-name}/` overrides. The plan stores the effective instruction source paths so a resumed session can explain which rules it is following.

### 4.4 Simplified steps.json

```json
{
  "fork_id": "uuid",
  "plan_uuid": "uuid",
  "git_branch": "plan-xxx",
  "project_hash": "hash",
  "base_commit": "abc123",
  "last_commit": "def456",
  "current_phase": "TDD_LOOP",
  "current_work_item": "unit_1",
  "work_items": [
    {
      "id": "unit_1",
      "kind": "function",
      "name": "validateEmail",
      "signature": "function validateEmail(email: string): boolean",
      "status": "completed",
      "child_branch": null,
      "child_commit": "def456",
      "merge_commit": "fed789",
      "test_count": 4,
      "verification": "passed"
    },
    {
      "id": "unit_2",
      "kind": "function",
      "name": "hashPassword",
      "signature": "function hashPassword(password: string): string",
      "status": "pending",
      "child_branch": null,
      "child_commit": null,
      "merge_commit": null,
      "test_count": 0,
      "verification": null
    }
  ],
  "pi_session": {
    "session_id": "pi-session-id",
    "fork_id": "pi-fork-or-leaf-id",
    "last_seen_entry_id": "entry-id"
  },
  "refactor_iterations": 0,
  "completed_at": null
}
```

### 4.5 New Lifecycle Phases

```
IDLE → DISCOVERY → PLAN → TDD_LOOP → REFACTOR_LOOP → API_CHECK → DOCUMENTATION → COMPLETE
```

Simplified transitions:
- **IDLE** → DISCOVERY (always)
- **DISCOVERY** → PLAN (model decides)
- **PLAN** → TDD_LOOP (model decides)
- **TDD_LOOP** → TDD_LOOP (next work item) or REFACTOR_LOOP (all work items done)
- **REFACTOR_LOOP** → REFACTOR_LOOP (more iterations) or API_CHECK (done)
- **API_CHECK** → DOCUMENTATION (model decides)
- **DOCUMENTATION** → COMPLETE (model decides)

No HYPOTHESIZE, no ADAPT, no BACKTRACK, no DEBUG, no COMPACT phases.
These are all handled WITHIN the TDD_LOOP and REFACTOR_LOOP stages.

### 4.6 New Tools (Simplified)

1. **`planner.plan`** — Create plan + target git branch
2. **`planner.add_steps`** — Add atomic work items to the plan
3. **`planner.start_step`** — Start one work item: create child branch, write child plan files, inject stage instructions
4. **`planner.finish_step`** — Finalize one completed work item: validate, commit child branch, merge into target, delete/archive child branch, update plan, compact
5. **`planner.status`** — Check current phase and next work item
6. **`planner.list`** — List all plans
7. **`planner.reset`** — Reset to IDLE
8. **`planner.delete_plan`** — Delete a plan
9. **`planner.get_active_plan`** — Read plan.md
10. **`planner.override_commit`** — Override expected commit
11. **`planner.reload_settings`** — Reload extension/project settings and stage markdown overrides

Removed or deferred as user-facing tools: `planner.fork`, `planner.switch`, `planner.edit_plan`, `planner.update_comprehension`

`planner.fork` and `planner.switch` are not part of the first public tool set, but Pi fork/session events must still be tracked internally. `edit_plan` is replaced by controlled state updates from specific tools. `update_comprehension` is replaced by explicit markdown stage instructions and required discovery outputs.

### 4.7 Git Strategy

**Target branch:** `plan-{task-short-name}` — the main branch for the entire task.

**Child branches:** `plan-{task-short-name}-unit-{N}` — one per work item, created/destroyed or archived per TDD cycle.

**Merge strategy:** `git merge --no-ff` — always create merge commit for traceability.

**Branch lifecycle:**
1. Extension creates child branch from target when `planner.start_step` runs
2. Model implements + tests on child branch
3. Extension commits verified changes when `planner.finish_step` runs
4. Extension merges child into target
5. Extension deletes or archives child branch according to settings

This ensures the target branch always has clean, tested code. Child branches are ephemeral.

### 4.8 Settings and Instruction Loading

The extension must support configurable markdown instructions because the planner is mainly a control system for a local model. Different projects and users need different rules.

Settings locations:
- Built-in defaults inside the extension package
- Extension-level config near the installed extension, for global user preferences
- Project-level overrides under `.pi/{extension-name}/`

Configurable items:
- Stage instruction markdown paths: discovery, planning, TDD/work item, refactor, API check, documentation, completion
- Commit style markdown and default commit message templates
- Verification commands per project
- Refactor iteration limits
- Whether child branches are deleted or archived
- Extra project rules injected into discovery and work item prompts

The effective settings should be copied or referenced in the plan state so resumed sessions are deterministic.

### 4.9 Pi Fork / Session Synchronization

Pi's own fork/session system must be studied and integrated before the git layer is considered complete.

Target behavior:
- If a plan is active and Pi creates a fork of the conversation/history, the extension records the new Pi fork/session identity.
- The extension maps Pi session/fork identity → planner plan UUID → expected git branch/commit.
- When the user resumes or switches a Pi session, the extension restores the matching plan and checks out or warns about the matching git branch.
- If the git branch or commit does not match the saved plan state, the extension blocks unsafe planner operations and tells the model what state mismatch exists.

This system is separate from ephemeral work item child branches. Child branches are implementation isolation. Pi forks are conversation/history isolation.

---

## PART 5: Key Differences Summary

| Aspect | Old Version | New Version |
|--------|-------------|-------------|
| **Context compaction** | After every step | After every completed atomic work item; never mid-unit |
| **Task granularity** | Linear steps (split arbitrarily) | One work item = one isolated unit |
| **Git branching** | One branch per plan | One target + many ephemeral child branches |
| **Sync mechanism** | Complex (both/md_only/json_only) | None — steps.json is source of truth |
| **Comprehension** | Numeric scores, thresholds | Explicit discovery/stage instructions and required outputs |
| **DAG** | Complex dependency graph | Simple sequential |
| **Phases** | 12 phases, complex transitions | 7 phases, simple transitions |
| **Testing** | After implementation | Before implementation when testable; equivalent verification for non-code units |
| **Child plans** | Fork-based (copy everything) | Git branch-based work item isolation |
| **Rewind** | Not implemented | Built into TDD cycle |
| **Refactoring** | Not implemented | Configurable N iterations |
| **API cleanup** | Not implemented | Automatic unused code detection |
| **Documentation** | Not implemented | JSDoc for all public API |
| **Settings** | Hardcoded behavior | Layered markdown/settings overrides |
| **Pi fork/session sync** | Not handled correctly | Required internal mapping to plan/git state |
| **Tools** | 13 tools | Small public tool set + internal event handlers |

---

## PART 6: What to Tell the Other Model

When you send this to another model, include:

1. **The full codebase** — all source files in `/home/m62624/Projects/main/pi-iterative-planner/src/`
2. **The test files** — all `*.test.ts` files
3. **The docs** — `docs/EXTENSION.md`, `SDK.md`, `TUI sdk.md`
4. **The package.json** — for dependencies
5. **This analysis** — `ANALYSIS_OLD_VS_NEW.md` (the document you're reading now)

The instruction to the other model should be:

> "You are building a complete rewrite of the pi-iterative-planner extension. Study the existing code in `/home/m62624/Projects/main/pi-iterative-planner/src/` only as a prototype and source of lessons. The existing code has fundamental architectural flaws (see ANALYSIS_OLD_VS_NEW.md). Your job is to implement the new architecture described in the analysis using the current Pi SDK APIs and current TUI APIs. Focus on:
>
> 1. **Simplification** — Remove unnecessary complexity (DAG, sync mechanism, complex phase machine)
> 2. **Work-item isolation** — One function/class/UI/config/docs/migration unit at a time
> 3. **TDD/verification-first** — Tests before implementation when testable, equivalent verification otherwise
> 4. **Context preservation** — No compaction mid-work-item; compact after `finish_step` when the unit is verified and recorded
> 5. **Controlled git flow** — Extension manages child branches, commits, merges, branch cleanup, and branch/commit mismatch warnings
> 6. **Layered settings** — Built-in defaults, extension-level settings, and project `.pi/{extension-name}/` markdown overrides
> 7. **Pi fork/session synchronization** — Map Pi conversation/session forks to planner plan state and expected git state
> 8. **Configurable refactoring** — N iterations with compact between each
> 9. **API cleanup** — Remove unused internal code while preserving intended public API
> 10. **Documentation** — JSDoc for public API and clear generated plan summaries
>
> The extension is a control and guardrail system for a local model: it does not implement code instead of the model. It manages state, instructions, git, verification checkpoints, and compaction. All code and internal documentation should be in English. User-facing prompts can follow detected/project language."

# Planner Workflow Draft

This document describes the target workflow for the planner harness. It is a
design draft, not a completed implementation contract.

## Goal

The planner is optimized for local models with limited context. The extension
must keep the model inside a strict lifecycle, persist compressed project memory,
and use git checkpoints so the model can solve large tasks through many small,
recoverable steps.

The model may reason and write code inside an allowed stage. Stage transitions,
git operations, recovery, compaction boundaries, and required artifacts are
controlled by the extension.

## Global Lifecycle

1. `idle`
   - No active planner workflow.
   - Pi behaves normally.

2. `plan_draft`
   - The user describes the goal.
   - The model may ask initial clarifying questions.
   - No project-wide code changes are allowed.

3. `discovery_full`
   - The model may spend large context on reading the project, SDK docs,
     libraries, existing APIs, tests, and patterns.
   - Outputs are persisted as compressed project memory.
   - Expected artifacts:
     - `project_summary`
     - `signature_index`
     - `library_versions`
     - `project_patterns`
     - `architecture_notes`
     - `open_questions`
     - `risk_notes`

4. `discovery_compact_required`
   - The extension blocks normal work and requires `ctx.compact`.
   - The compact instruction must tell the model to continue from persisted
     memory/index files instead of rereading the whole project.

5. `post_discovery_questions`
   - After compaction, the model reads compressed memory and asks remaining
     questions.
   - The model must report whether it is confident enough to plan.

6. `todo_planning`
   - The model creates machine-readable work items.
   - No implementation is allowed.

7. `skeleton_planning`
   - The model decides which stubs/contracts are needed.
   - No full implementation is allowed.

8. `skeleton_write`
   - The model writes stubs with planner markers.
   - Every stub must be tied to a plan id, work item id, and stub id.

9. `stub_audit`
   - The extension/model checks that all expected stubs exist, no unexpected
     stubs exist, and every stub is registered.

10. `work_item_ready`
    - One atomic work item/stub can be selected for TDD.

11. `work_item_tdd_tournament`
    - Tests are written once on the child branch.
    - Multiple experiment branches implement different attempts.
    - Exactly one candidate is selected.

12. `signature_refresh`
    - Changed files/symbols are reindexed.
    - Project memory is updated without full rediscovery unless required.

13. `signature_refresh`
    - Changed files/symbols are reindexed after an atomic committed work item.

14. `work_item_compact_required`
    - The extension requires compaction after an atomic committed work item.

15. `plan_finalize`
    - All required work items are complete.
    - The user decides whether to merge/archive/cancel the plan.

16. `recovery_required`
    - Runtime state and git state diverged, or a crash left a pending operation.
    - Normal transitions are blocked until recovery is resolved.

## Work Item TDD Tournament

Each work item uses a tournament-style TDD flow. Experiment branches are not
refactored. They exist only to produce alternative implementations. Refactor
happens only on the child branch after a single winning candidate is selected.

### 1. Start Work Item

The extension creates a child branch:

```text
planner/<planId>/work/<workItemId>
```

The child branch starts from the current clean plan commit. The extension stores
the work item base commit.

### 2. Select Stub

The model selects exactly one stub/atomic unit. The extension provides only the
needed context:

- active plan summary
- selected work item
- selected stub marker
- relevant signature index entries
- relevant project patterns
- concrete files only when needed

### 3. Prepare TDD

The model writes a TDD plan artifact for the selected stub. It describes:

- expected behavior
- edge cases
- verification commands
- success/failure criteria
- files likely to be touched

No implementation is allowed in this stage.

### 4. Write Tests

The model writes or updates tests for the selected stub. Implementation is still
not allowed.

The extension must ensure the child branch is committed before experiment
branches are created. This avoids carrying uncommitted test changes between
branches.

The extension creates a child commit such as:

```text
test: define <workItemId> behavior
```

This commit becomes `experimentBaseCommit`.

### 5. Create Experiment Attempts

For each attempt from `1..N`, the extension creates a branch from the same
`experimentBaseCommit`:

```text
planner/<planId>/experiment/<workItemId>/attempt-1
planner/<planId>/experiment/<workItemId>/attempt-2
planner/<planId>/experiment/<workItemId>/attempt-3
```

Each attempt has its own isolated git branch and its own filesystem artifact
directory:

```text
work_items/<workItemId>/experiments/<attemptId>/
  plan.md
  prompt.md
  summary.md
  score.json
  verification.json
  changed_files.json
```

The attempt `plan.md` is local to that attempt. It should describe the intended
implementation strategy for that branch.

The attempt `summary.md` must include:

- what was implemented
- what passed
- what failed
- strengths
- weaknesses
- tradeoffs
- changed files
- notes for later attempts

Each attempt is committed on its own experiment branch after implementation.

### 6. Attempt Variation

Attempts should not be identical. The model receives summaries from previous
attempts and must try a meaningfully different strategy.

Default intended variation:

- attempt 1: straightforward implementation
- attempt 2: alternative structure/algorithm
- attempt 3: minimal-diff/project-style-focused implementation
- attempts after 3: target the weakest criterion from previous attempts

The exact strategy can be overridden by project instructions.

### 7. Numeric Scoring

Each attempt receives objective and model-evaluated metrics. Hard blockers are
checked first. An attempt with a hard blocker cannot be selected, regardless of
score.

Hard blockers:

- tests failed
- build/check failed
- selected stub marker remains unresolved
- forbidden files were touched
- required artifact is missing

Example `score.json`:

```json
{
  "attemptId": "attempt-2",
  "hardBlockers": {
    "testsPassed": true,
    "buildPassed": true,
    "noStubMarkersLeft": true,
    "noForbiddenFilesTouched": true,
    "requiredArtifactsExist": true
  },
  "scores": {
    "correctness": 1.0,
    "projectStyleFit": 0.85,
    "simplicity": 0.7,
    "maintainability": 0.8,
    "performance": 0.6,
    "diffSize": 0.75,
    "integrationRisk": 0.2
  },
  "weightedScore": 3.69
}
```

Default formula:

```text
weightedScore =
  correctness * 1.0
+ projectStyleFit * 0.8
+ simplicity * 0.8
+ maintainability * 0.7
+ performance * 0.4
+ diffSize * 0.3
- integrationRisk * 0.8
```

The extension can compute objective values such as test/build results, diff
size, changed file count, and verification time. The model can evaluate
subjective values such as project style fit, maintainability, simplicity, and
integration risk according to markdown instructions.

### 8. Select Exactly One Candidate

After all required attempts are complete, the extension/model selects exactly
one winning attempt.

The extension switches back to the child branch and merges the winner:

```text
git merge --no-ff planner/<planId>/experiment/<workItemId>/<winnerAttemptId>
```

Only the winner is merged. Loser branches are not refactored.

### 9. Cleanup Rejected Attempts

After the winner is merged, all non-winning experiment branches are deleted or
archived according to settings.

The default policy is:

- delete rejected experiment branches
- keep attempt summaries and scores
- keep enough metadata to explain why a candidate lost
- never refactor rejected attempts

Each rejected attempt's filesystem artifact directory may be deleted or retained
according to settings. If retained, it is read-only historical evidence.

### 10. Refactor Winner On Child Branch

Refactor happens only after candidate selection, on the child branch.

The model may clean up the selected implementation while preserving behavior.
Changing the public contract requires returning to the test stage.

### 11. Verify Candidate

The extension runs required verification commands. If verification fails, the
workflow may:

- return to refactor
- create an additional experiment attempt
- block the work item for user input

### 12. Commit Work Item

The extension creates the final work item commit on the child branch. It updates:

- expected git branch/commit
- work item status
- dirty signature entries
- stub registry
- verification artifacts

### 13. Refresh Memory

Changed symbols/files are reindexed. The signature index and project memory are
updated incrementally.

The model must continue from memory/index artifacts instead of rereading the full
project.

### 14. Require Work Item Compact

After memory refresh, the work item enters `work_item_compact_required`. Normal
work on the next item is blocked until compaction happens.

The compact instruction must preserve:

- current plan id
- completed work item id
- summary of the committed change
- next expected stage
- instruction to continue from memory/index artifacts

After compact completes, the work item can enter `completed`.

## Git Rules

- Child branch must be clean and committed before any experiment branch is
  created.
- Every experiment branch starts from the same `experimentBaseCommit`.
- Every successful experiment branch must have its own implementation commit.
- Exactly one experiment branch can be selected.
- Rejected experiment branches are never refactored.
- Refactor happens only on the child branch after the winner is merged.
- Rejected experiment branches can be deleted after summaries/scores are saved.
- Planner git tools are the only allowed way to commit, switch, merge, reset, or
  delete planner-managed branches while a plan is active.

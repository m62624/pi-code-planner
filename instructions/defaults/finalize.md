# finalize

## Purpose

Verify the complete plan branch as one integrated result, write a durable user-facing summary, compact the final context, and enter the explicit acceptance stage.

## Strict Step Order

1. `verify_plan_branch`
	- Inspect planner git state and confirm that all required tasks were merged.
	- Run project-level checks defined by project instructions and task evidence from the worktree path reported by `planner_status`.
	- Record failures, residual risks, and any checks that cannot run locally.
2. `doubt_review`
	- Before asking for user acceptance, deliberately doubt the completed result.
	- Reread `goal.md`, `plan.md`, task artifacts, `verify.md`, and the final worktree diff.
	- Start with a `Possible Errors` list written in `metadata.doubtReviewLanguage`. These are suspicions, not bugs yet.
	- Assign every possible error to one risk category: `requirement_mismatch`, `missing_test`, `boundary_case`, `integration_break`, `state_machine_error`, `persistence_error`, `recovery_error`, `wrong_file_scope`, `user_flow_regression`, or `cleanup_or_debug_leftover`.
	- For each possible error, prove it, disprove it, or mark it `needs_probe`. Use `planner_doubt_review`; do not hand-write `verify.md`.
	- A suspected issue may be called `proven_bug` only after a failing test/command, exact code-path proof, or exact spec contradiction.
	- `needs_probe` findings cannot finish the step. Run the probe or downgrade with proof.
	- If `proven_bug` findings exist, write them to `decisions.md`, then return to `planning/read_context` for revision tasks. Do not patch ad hoc in finalize.
	- If a finding mentions placeholder, stub, TODO-only, hardcoded behavior, superficial implementation, missing tests, or unresolved work, it cannot be closed as `not_a_bug` or `disproven`. It must be `proven_bug` or `needs_probe`.
	- If a proven or disproven finding teaches a reusable workflow lesson, call `planner_skill_create` with `sourceKind=doubt_review`.
	- If no proven bug or probe remains, continue to `write_final_summary`.
3. `write_final_summary`
	- Write `final_summary.md`.
	- Use `metadata.humanLanguage` from `planner_status` unless the user explicitly requested another language.
	- Include completed scope, changed files, checks, risks, output branch expectations, and unresolved limitations.
	- If the whole plan produced a reusable verified lesson not already captured, call `planner_skill_create` with `sourceKind=final_summary`.
4. `compact_finalize`
	- Request planner-controlled compact preserving summary, verification, branch state, and risks.
5. `enter_done`
	- Advance to `done/present_result`.

## Restrictions

- Do not introduce new production behavior during finalize.
- Do not run tests, builds, linters, formatters, or project-specific checks from the original checkout. Use the planner worktree as shell cwd.
- Do not cleanup the worktree or plan files.
- Do not export the plan result before explicit user acceptance.
- Do not use raw git.
- If checks reveal missing implementation, record the issue and return through the controlled planning flow instead of patching ad hoc.
- During `doubt_review`, assume there may still be bugs even if tests pass. Passing checks are evidence, not acceptance.
- Do not call a finding a bug from suspicion alone. Suspicions without proof are `needs_probe`, not revision tasks.
- Do not normalize away placeholders or shallow implementations. If a placeholder/surface-level implementation remains, return to planning with a proven finding or run a probe.

## Doubt Review Proof Rules

Every possible error must be classified:

- `proven_bug`: verified by `reproduced_test`, `reproduced_command`, `code_path_proven`, or `spec_contradiction`; must return to planning.
- `disproven`: dismissed by `disproven_by_test` or `disproven_by_code`; no action.
- `needs_probe`: plausible but not proven; run one focused probe before finishing the step.
- `not_a_bug`: valid behavior or design preference; no action.

Tests are preferred for runtime behavior. Code-path proof is allowed only when the exact path makes the behavior impossible or directly contradicts the approved spec.

## Doubt Review Method

This step is a verification stage, not a writing exercise. Treat it like TDD for suspected problems:

1. Reconstruct the promise.
   - Read the approved goal, the current plan, completed task files, final summary if present, and the final diff.
   - Write down what the result must do, what it explicitly must not do, and which project checks already passed.
   - Do not trust memory from earlier chat turns. Durable artifacts and the current worktree are the source of truth.
2. Generate possible errors before deciding.
	- List concrete possible errors in `metadata.doubtReviewLanguage` under `Possible Errors`.
	- A possible error must point to a requirement, a code path, a changed file, a missing test, a migration risk, or an integration boundary.
	- Choose the narrowest risk category before deciding whether the issue is real.
	- Do not include vague anxiety such as "maybe something is wrong" or style preferences without product impact.
3. Prove or disprove each possible error.
   - For behavior, prefer a focused failing test or a focused command that reproduces the issue.
   - For static correctness, trace the exact code path and name the files/symbols that force the conclusion.
   - For spec mismatch, quote the exact approved requirement and the exact implemented behavior that contradicts it.
   - If the evidence is not enough, mark `needs_probe` and run one targeted probe before finishing. Do not convert uncertainty into a bug.
4. Decide the route.
   - If any finding is `proven_bug`, record it in `decisions.md` and finish this step with target `planning/read_context`.
   - Planning must then create revision tasks. Do not patch production files inside finalize.
   - If all findings are `disproven` or `not_a_bug`, finish this step with target `finalize/write_final_summary`.
5. Keep the artifact strict.
   - Use only `planner_doubt_review` to write the final doubt artifact.
   - Every finding must include `claim`, `specReference`, `codePath`, `verification`, evidence, and `nextAction`.
   - `needs_probe` is not a terminal state. The runtime will block leaving this step until every probe is resolved.

Do not reward yourself for finding many bugs. Reward exactness. False positives waste revision cycles; false negatives ship broken work. The correct outcome may be "no proven bugs remain" if every suspicion was checked and dismissed with evidence.

## Planner Skill Memory

Use `planner_skill_create` only for verified lessons that should improve future planner sessions. A skill is not a final summary. It must describe a reusable trigger and workflow, for example a Pi extension stale-ctx pattern, a recovery proof method, or a specific class of state-machine mistake.

The skill body should be written in `metadata.skillLanguage`. The wrapper writes YAML frontmatter and stores the skill under the planner extension library. The new skill is loaded through Pi `resources_discover` on future planner session start, resume, or reload.

## Exit Condition

Finalize is complete only when the integrated plan branch is checked, `final_summary.md` exists, final compact finishes, and state enters `done/present_result`.

## manual-compact

Preserve `final_summary.md`, project-level verification results, changed-file summary, branch state, known risks, and unresolved limitations. After compaction, call `planner_status`, read the final summary and verify artifacts, then enter done flow.

## auto-compact

Call `planner_status` immediately. Restore the exact finalize step and reread `final_summary.md` if it already exists. Do not export or cleanup until explicit user acceptance is recorded.

## Finalization & Verification Diagnostics

### 1. Pre-Merge Verification Failures
- **Integration Test Regressions**: If final tests fail on the plan branch, identify if the issue is a merge conflict regression.
- **Clean Diff Verification**: Run code inspection to ensure no temporary debug lines, print statements, or scratch files are committed.
- **Branch Synchronization**: Verify that the plan branch is fully up-to-date with the main base branch.

### 2. Resolution Flow
1. Run lint and format checks before finalizing.
2. If integration tests fail, rollback the merge, fix the bug in the task branch, and try merging again.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

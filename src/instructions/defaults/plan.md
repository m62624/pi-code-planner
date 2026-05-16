# idle

Goal: normal agent mode with no active planner workflow.
Allowed: answer the user normally or create a planner plan if the task needs planner control.
Required tools: `planner_create_plan` only when starting planner-controlled work.
Forbidden: pretending planner state exists.
Next stage: `plan_draft` after `planner_create_plan`.

# plan_draft

Goal: capture the user's goal as a planner-controlled task.
Allowed: ask the user clarifying questions and write planner artifacts only.
Required tools: normally `planner_transition_plan` to `discovery_full`.
Forbidden: project reads, project edits, memory indexing, work item creation, tests, implementation.
Exit condition: the task title and scope are clear enough to start discovery.
Next stage: `discovery_full`.

# post_discovery_questions

Goal: resolve only the questions discovery could not answer.
Allowed: read persisted discovery artifacts and compressed memory, ask focused questions, update questions/decisions artifacts.
Required tools: `planner_transition_plan` to `todo_planning` when questions are resolved, or back to `discovery_full` if evidence is insufficient.
Forbidden: broad project rereads, project edits, work item implementation.
Exit condition: requirements are clear enough to create atomic work items.
Next stage: `todo_planning`.

# todo_planning

Goal: create the backlog from discovery evidence.
Allowed: create machine-readable work items. Each item must be atomic, testable, and tied to concrete files, APIs, stubs, or behavior.
Required tools: `planner_create_work_item` for each item, then `planner_transition_plan` to `skeleton_planning`.
Forbidden: project edits, tests, implementation, starting a work item before the plan reaches `plan_active`.
Exit condition: every required unit has a work item with a clear testable outcome.
Next stage: `skeleton_planning`.

# skeleton_planning

Goal: design stubs, markers, contracts, and expected test boundaries.
Allowed: write planner artifacts that describe stubs/contracts and marker format.
Required tools: `planner_transition_plan` to `skeleton_write`.
Forbidden: project code edits, test edits, implementation behavior.
Exit condition: the needed skeleton/marker plan is explicit.
Next stage: `skeleton_write`.

# skeleton_write

Goal: persist the skeleton plan without touching project code.
Allowed: write only planner artifacts that describe required stubs, markers, and where future work items will operate.
Required tools: `planner_transition_plan` to `stub_audit`.
Forbidden: project code edits, test edits, production stubs in source files. Project source changes belong to work item TDD stages.
Exit condition: skeleton artifacts are written and auditable.
Next stage: `stub_audit`.

# stub_audit

Goal: verify the skeleton artifacts before execution starts.
Allowed: read planner artifacts, inspect memory, and confirm every planned stub/unit maps to a work item.
Required tools: `planner_transition_plan` to `plan_ready` when audit passes, or back to `skeleton_planning` if gaps exist.
Forbidden: project edits, implementation, tests.
Exit condition: no missing or extra planned stubs/units remain.
Next stage: `plan_ready`.

# plan_ready

Goal: prepare execution.
Allowed: confirm no unresolved discovery, stub, or memory blocker remains.
Required tools: `planner_transition_plan` to `plan_active`.
Forbidden: starting implementation directly from plan level.
Exit condition: plan can safely execute work items one at a time.
Next stage: `plan_active`.

# plan_active

Goal: select or progress exactly one work item.
Allowed: transition a pending work item to `ready`, then follow the work item TDD lifecycle.
Required tools: `planner_transition_work_item` to `ready`, then work item tools.
Forbidden: project edits at plan level, parallel active work items unless explicitly represented as experiment branches.
Exit condition: a single work item is active or all work is complete.
Next stage: work item lifecycle or `plan_finalize`.

# plan_finalize

Goal: summarize completed work and make final merge/archive choices explicit.
Allowed: read final artifacts, summarize commits, verification, memory status, and remaining risks.
Required tools: `planner_transition_plan` to `plan_completed` after user-visible summary is ready.
Forbidden: new implementation.
Next stage: `plan_completed`.

# plan_completed

Goal: terminal completed state.
Allowed: summarize or inspect final artifacts.
Forbidden: continuing implementation unless the user starts a new plan.

# plan_cancelled

Goal: terminal cancelled state.
Allowed: summarize cancellation and recovery options.
Forbidden: continuing implementation.

# recovery_required

Goal: stop normal work until state is safe.
Allowed: inspect runtime/git recovery details, use planner recovery tools, or ask the user for the recovery choice.
Forbidden: project edits, tests, implementation, direct shell git recovery unless explicitly allowed by planner tools.

# details

Standard process:
1. Understand the current stage and artifacts.
2. State the smallest next action.
3. Use planner tools for stage transitions.
4. Do not bypass git, memory, or compact guardrails.
5. Work item execution is TDD-only: tests first, production code second, refactor after candidate selection.

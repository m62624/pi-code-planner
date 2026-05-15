# plan_draft

Clarify the user's goal and convert it into a planner-controlled task. Do not edit project code.

# post_discovery_questions

Read the persisted discovery artifacts and compressed memory. Ask only the remaining questions required to create a reliable plan. Do not reread the whole project unless memory is insufficient.

# todo_planning

Create machine-readable work items. Each work item must be atomic, testable, and tied to concrete files, APIs, or stubs.

# skeleton_planning

Design the stubs/contracts needed for the plan. Do not implement behavior.

# skeleton_write

Write only stubs and planner markers. Each marker must identify the plan, work item, and stub or unit it belongs to.

# stub_audit

Verify that expected stubs exist, unexpected stubs are absent, and every stub is registered in planner artifacts.

# plan_ready

Prepare to select the next atomic work item. Confirm there is no unresolved discovery, stub, or memory blocker.

# plan_active

Continue the active plan by selecting or progressing one work item. Keep work isolated to the current planner stage.

# plan_finalize

Summarize completed work, remaining risks, verification status, and merge/archive choices for the user.

# plan_completed

The plan is complete. Do not continue implementation unless the user starts a new plan.

# plan_cancelled

The plan is cancelled. Do not continue implementation.

# recovery_required

Normal work is blocked. Inspect runtime and git recovery details, then use planner recovery tools or ask the user for the recovery choice.

# details

Standard process:
1. Understand the current stage and artifacts.
2. State the smallest next action.
3. Use planner tools for stage transitions.
4. Do not bypass git, memory, or compact guardrails.

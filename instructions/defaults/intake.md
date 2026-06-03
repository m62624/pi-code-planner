# intake

## Purpose

Turn the user's raw request into an explicit approved goal before reading project source. Intake protects the planner from implementing an inferred title or an ambiguous task.

## Strict Step Order

1. `draft_goal`
   - Read `request.md`.
   - Write `goal.md` in your own words.
   - Include the requested outcome, current assumptions, non-goals, and constraints.
   - Do not invent project-specific questions before reading project evidence.
   - Propose a short plan title with `planner_goal_submit`. Prefer a concise English phrase unless the user explicitly requests another language.
   - The title is user-facing and may contain Unicode. It is not the stable branch-safe `planId`.
   - Do not inspect project source.
2. `await_goal_approval`
   - Show the user the full generated `goal.md` content. The `planner_goal_submit` result includes it for review.
   - Explain that `plan.md` is intentionally written later, during `planning/draft_plan`, after discovery and evidence-based questions are complete.
   - Ask whether the goal and proposed title are approved or need revision.
   - If revision is requested, update `goal.md`, propose a revised title when needed, and ask again.
   - Enter discovery only after explicit approval.

## Restrictions

- Do not inspect project source, manifests, tests, or implementation files.
- Do not implement code or write tests.
- Do not create tasks.
- Do not infer approval from silence.
- Do not use raw git.

## Exit Condition

Intake is complete only after `goal.md` reflects the user's intent and the user explicitly approves it.

Evidence-based clarification questions belong to `discovery/write_questions`, after the model has indexed the project. Intake may ask the user only when the requested outcome itself is too ambiguous to normalize.

## auto-compact

Call `planner_status` immediately. Read `request.md` and `goal.md`, then resume the exact intake step. Do not begin discovery without explicit approval.

## Intake & Goal Diagnostics

### 1. Goal Ambiguity & Verification
- **Identify Underspecified Outcomes**: If the user's initial request lacks concrete metrics (e.g., "make it faster" or "fix bugs"), do not guess. Draft `goal.md` with explicit, testable criteria and ask the user for confirmation.
- **Assumptions vs. Facts**: List all technical assumptions explicitly under a dedicated header in `goal.md`. Treat any unconfirmed assumption as a risk.
- **Scope Creep Prevention**: Clearly define "Non-Goals" to prevent the model from wandering into unrelated parts of the codebase.

### 2. Failure Diagnostics
- **If the user rejects the goal**: Do not argue. Ask for specific feedback, rewrite the goal, and re-submit.
- **If the user is unresponsive**: Keep the goal simple and await explicit approval. Never move to discovery without a signed-off `goal.md`.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

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

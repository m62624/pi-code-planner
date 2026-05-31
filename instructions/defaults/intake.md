# intake

## Purpose

Turn the user's raw request into an explicit approved goal before reading project source. Intake protects the planner from implementing an inferred title or an ambiguous task.

## Strict Step Order

1. `draft_goal`
   - Read `request.md`.
   - Write `goal.md` in your own words.
   - Include the requested outcome, current assumptions, non-goals, constraints, and focused clarification questions.
   - Do not inspect project source.
2. `await_goal_approval`
   - Show the user the exact `goal.md` path and a concise summary.
   - Ask whether the goal is approved or needs revision.
   - If revision is requested, update `goal.md` and ask again.
   - Enter discovery only after explicit approval.

## Restrictions

- Do not inspect project source, manifests, tests, or implementation files.
- Do not implement code or write tests.
- Do not create tasks.
- Do not infer approval from silence.
- Do not use raw git.

## Exit Condition

Intake is complete only after `goal.md` reflects the user's intent and the user explicitly approves it.

## auto-compact

Call `planner_status` immediately. Read `request.md` and `goal.md`, then resume the exact intake step. Do not begin discovery without explicit approval.

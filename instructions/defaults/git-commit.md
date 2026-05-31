# git-commit

## Purpose

Generate concise planner-controlled commit and merge messages. This file controls message style only. It never changes branch lifecycle, merge targets, or permission rules.

## Commit Message Rules

- Use imperative mood.
- Keep the subject concise and specific.
- Describe the completed atomic checkpoint, not the implementation process.
- Prefer one clear subject line.
- Mention the task or behavior when it improves clarity.
- Do not include raw model reasoning, temporary uncertainty, or verbose test logs.
- Do not use vague subjects such as `update files`, `fix stuff`, `changes`, or `wip`.
- Do not claim tests passed unless checks were actually run.

## Suggested Subjects

```text
test: cover <behavior>
feat: implement <behavior>
fix: handle <edge case>
refactor: simplify <component>
docs: record <decision>
```

Use the repository's existing convention when it is discoverable. Project append instructions may override language, prefix style, scope style, merge subject style, and team conventions.

## Experiment Checkpoints

Experiment commit messages should identify the attempted behavior or approach without pretending the candidate is final.

```text
feat: try <approach> for <task>
```

## Merge Messages

- Experiment -> task: identify selected attempt and task.
- Refactor -> task: identify behavior-preserving cleanup.
- Task -> plan: identify completed atomic task.
- Plan -> output: identify accepted planner result.

## Restrictions

- Never call raw `git commit`.
- Never choose merge branches from this document.
- Never rewrite history to polish messages automatically.

## auto-compact

After auto-compact, call `planner_status`. Use this style only when the current stage explicitly allows a planner commit or merge wrapper.

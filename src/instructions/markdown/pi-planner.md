---
name: pi-planner
description: "Structured planning workflow for pi-coding-agent. If the user asks to create a plan, use planner_create_plan immediately without asking questions or reading the project. The extension will provide the next instruction."
---

# pi-planner

This is the **pi-planner** extension — a phase-gated planning workflow for pi-coding-agent.

## How it works

When you create a plan with `planner_create_plan`, the extension enters a structured workflow:

1. **Discovery** — read the project, build memory. No code edits.
2. **Planning** — create work items. No implementation.
3. **Execution** — work on items one at a time, TDD discipline.
4. **Verification** — run tests and verification commands.

Each phase has strict rules about what you can and cannot do.

## When user asks to create a plan

**Do not ask questions.** Call `planner_create_plan` with the user's request as the title. The extension will provide the next instruction with specific guidance for the current phase.

## Key rules

- One work item at a time
- TDD: tests before production code
- No code edits during discovery or planning phases
- Use planner tools for all git operations
- Memory over chat history

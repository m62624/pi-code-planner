# pi-planner Docs

This directory is the design and implementation memory for pi-planner. Keep it
updated when a layer changes so future workflow work does not depend on chat
history.

## Documents

- [Settings](settings.md)
  - Where global and project settings live.
  - Which fields are editable.
  - Which values belong in JSON and which belong in markdown instructions.

- [Runtime State](runtime-state.md)
  - Persistent `state.json`.
  - Runtime modes.
  - Git position tracking.
  - Branch registry and pending operation recovery.

- [Git Safety](git-safety.md)
  - Git read/write boundaries.
  - Branch naming safety.
  - Policy, recovery, mutations, preflight, and public Pi tools.
  - Direct git command guardrails.

- [Instruction Sections](instruction-sections.md)
  - Generic markdown section parser rules.
  - How callers can retrieve operation-specific instruction sections.

- [Workflow](workflow.md)
  - Target harness lifecycle.
  - Discovery and compaction stages.
  - Work item TDD tournament.
  - Experiment branch selection, scoring, cleanup, and refactor rules.

- [API Inventory](api.md)
  - Current TypeScript modules and exported APIs.
  - What is public, internal, or future-facing.

## Current Implementation Status

Implemented:

- settings and instruction file initialization
- global and project settings merge
- runtime state persistence and RAM cache
- git read layer
- git policy and recovery analysis
- git mutations with pending operation tracking
- configurable branch naming
- `GitCore` composition layer
- minimal Pi git tools
- tool-call guard analysis for direct git commands
- draft workflow document

Not implemented yet:

- persisted project memory
- plan/work item storage
- stub marker registry
- signature index generation
- workflow state machine
- compact orchestration
- full planner tools above git tools

## Design Rule

Markdown tells the model how to think. JSON/state tells the extension what it
can validate and enforce. Git operations must go through planner-controlled
layers while a plan is active.


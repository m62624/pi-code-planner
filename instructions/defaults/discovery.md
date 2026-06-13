# discovery

## Purpose

Become familiar with the project before planning. Keep this stage cheap for a local model: discover AGENTS.md local contracts first, inspect the project tree, read only the files needed for the approved goal, and summarize useful findings in `discovery.md`.

## Strict Step Order

1. `scan_project_structure`
   - Read `goal.md`.
   - Call `planner_contract_scan` in batches. This discovers AGENTS.md/AGENTS.MD canonical contracts and read-only context imports such as CLAUDE.md, GEMINI.md, .cursorrules, WARP.md, AIDER.md, and COPILOT.md without reading all file bodies.
   - If contract files exist, call `planner_contract_route` for the goal/scope and `planner_contract_read` for the relevant chain before broad source reads.
   - Treat AGENTS.md as the only writable/canonical planner memory format. Treat non-AGENTS context files as read-only guidance; if they contain durable planner knowledge, copy the distilled rule into the nearest AGENTS.md via `planner_contract_upsert`.
   - Inspect the project tree with read-only shell commands after the contract map is started.
   - Read only the manifests, entrypoints, tests, configuration, and source files needed to understand the requested work after contract guidance is considered.
   - Write a concise `discovery.md`: architecture, relevant paths, commands, conventions, risks, and uncertainty.
   - `discovery.md` must include a `## Verification Protocol` section before this step can finish.
   - In `## Verification Protocol`, record exact test, lint, build, and format commands when they exist. Include required working directory and important flags.
   - If commands are not discoverable, record `unknown` entries in `## Verification Protocol` and ask the missing setup questions in `discovery/write_questions`.
   - If no useful AGENTS.md exists and discovery evidence proves meaningful architectural zones, create initial root/domain contracts through `planner_contract_upsert`. Do not create one in every folder.
   - If `planner_contract_upsert` changes AGENTS.md files during discovery, commit those changes through `planner_git_commit` before finishing `scan_project_structure`.
2. `write_questions`
   - Call `planner_questions_submit` with evidence-based unresolved questions and explicit assumptions.
   - If the project is empty or has no existing test/lint/build conventions, ask how to set up testing: framework, test command, lint command, formatter, and any required flags.
   - If the project has existing conventions but discovery could not prove exact commands or flags, ask only for the missing commands/flags.
   - If questions exist, show them to the user verbatim and wait for answers.
   - Call `planner_questions_resolve` with the user's explicit answers.
   - If no questions remain, call `planner_questions_submit` with `hasOpenQuestions: false` and state that explicitly.
3. `compact_discovery`
   - Request planner-controlled compact only after `discovery.md` is useful and questions are resolved.
4. `enter_planning`
   - Advance to `planning/read_context`.

## Restrictions

- Do not implement production code or tests.
- Do not read the whole repository by default.
- Do not skip AGENTS.md routing when contract files exist. They are local architecture memory, not optional docs.
- Do not create AGENTS.md for every directory. A contract belongs only where it prevents future agents from reading irrelevant code or breaking a durable rule.
- Do not use the absence of AGENTS.md as evidence that no contract update is needed. For project file changes in a project with no writable AGENTS.md, create the initial meaningful contract.
- Do not build or maintain a file-by-file JSONL symbol index.
- Run project-scoped shell commands from the worktree path reported by `planner_status`.
- Do not use raw git.

## Exit Condition

Discovery is complete when `discovery.md` contains enough context for planning, includes `## Verification Protocol`, required user questions are answered or explicitly absent, and the configured discovery compact boundary finishes.

## Doubt Checkpoint

Before finishing discovery, doubt the context:

- Did you record exact test, lint, build, and format commands with working directory and important flags?
- If the project is empty or conventions are missing, did you ask how testing and checks should be set up?
- Are source findings backed by paths and evidence, not filenames or comments alone?
- Are open questions truly resolved, or only postponed?

If doubt remains, update `discovery.md`/`questions.md` or ask focused questions. Do not plan from vague project memory.

## Fundamental Rules

### Rule 1: System Boundaries

Before reading any file, determine two things:

**Internal** — files inside the project that you can read and edit. Code, configs, tests, project documentation.

**External** — everything outside the project. Host mechanisms, external APIs, runtime environments, servers, models, browsers, file systems outside the project root.

**Rule:** You do not write external code. You use or call external mechanisms. If a task requires an action performed by an external mechanism — the solution is in HOW to call the external mechanism, not in rewriting its code.

**Deduction:** If the task says "make X happen" and X is performed by an external mechanism — you do not write X. You find the integration point where the project can ASK the external mechanism to do X.

### Rule 2: Mechanism vs Outcome

Every requirement has two layers:

- **Outcome** — what should happen. The end state.
- **Mechanism** — HOW it happens. The means of achievement.

**Rule:** You investigate, you do not guess. When a task describes an outcome, you must NOT automatically think "I need to write code for this." Your first step is to investigate:

1. Is there already a mechanism in the project that can do this? Hooks, events, handlers, scheduler?
2. Is there a mechanism in the external world that can do this? Host API, ready-made integration?
3. Do you need new code, or just CONNECT to an existing mechanism?

Code is the last option. Not the first.

**Deduction:** Before writing a single line of code, you determine the mechanism. If the mechanism can be external — you find how to interact with it. If the mechanism already exists in the project — you connect to it. New code is written only when nothing suitable is found.

## manual-compact

Preserve the approved goal, `discovery.md`, relevant paths, commands, open questions, and exact current planner step. After compaction, call `planner_status`.

## auto-compact

Call `planner_status` immediately. Read `discovery.md` and continue the persisted step. Read additional source files only when the current context is insufficient.

## Advanced Discovery Logic & Cognitive Strategies

### Rule 3: Extreme Doubt and Logical Deduction
- **Doubt Everything Always**: Never assume any existing documentation, comments, or naming conventions are 100% accurate. Trust only what you can prove via real code, runtime execution, and tests.
- **No Unfounded Confidence**: You must assume you are missing critical details until you verify them. State your uncertainties explicitly. Never state that you are fully confident without proof.
- **Logically Deduce, Do Not Guess**: Every conclusion must be backed by a clear path of evidence. If you see function `A` calling `B`, do not guess what `B` does based on its name; find `B`'s definition and verify its behavior.

### Rule 4: Systemic Mapping of Input/Output Boundaries
To properly study and comprehend any system, component, or feature, you must exhaustively map its boundaries:
- **Income (Inputs)**: What triggers this module? What data, events, parameters, or configurations does it receive? Trace the source of all inputs to their origins.
- **Outcome (Outputs)**: What does this module produce? What side-effects, state changes, return values, file writes, or events does it trigger?
- **Detailed Boundary Study**: Never analyze a module in isolation. Study all incoming and outgoing connections first. Once you understand the input/output protocol, the internal logic becomes simple and predictable.

### Rule 5: Pivoting and Diagnostic Recovery
- **If You Get Stuck**: If a task remains blocked, do not repeatedly retry the same approach. Getting stuck is a signal that your initial assumptions were wrong, or you are moving in the wrong direction.
- **Analyze the Divergence**: Stop and map out what has been done so far. Identify where reality diverged from your expectations.
- **Pivot**: Move in another direction, simplify the problem, or backtrack to a known working state. Do not push forward blindly.

### Rule 6: Extreme KISS (Keep It Simple, Stupid)
- **Zero Bloat Principle**: Never create redundant functions, files, or utilities. Write only the absolute minimum amount of code required to satisfy the goal.
- **Reuse Existing Code First**: In your discovery phase, look for existing utility functions, methods, helper packages, and classes. Do not rewrite functionality that already exists in the project.
- **Avoid Over-Engineering**: Do not design complex abstract layers, massive factories, or unnecessary patterns unless explicitly requested. A simple procedural or straightforward object-oriented function is always preferred.

## If You Do Not Know What To Do Next

If you don't know what to do next, call `planner_status`.

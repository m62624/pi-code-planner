<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
Default model-facing instruction files for every planner stage and step. Each file defines purpose, tools, gates, forbidden actions, and recovery guidance for local LLMs.

### Parent
- `../AGENTS.md`

### Child Index
- (none)

### Stable Contracts
- Every file here is synced into planner storage on plan create/resume and can be overridden by user append files — never the reverse.
- Changing a file here changes what local models read on the next plan create/resume. Existing plans do not auto-update mid-session.
- Each stage file must stay self-contained: the model may only have this file in context, so it cannot rely on cross-file knowledge.

### Read First
- `discovery.md`
- `execution.md`
- `tdd.md`
- `planning.md`

### Do Not Touch Unless
- Do not remove concrete tool names, gate rules, or forbidden-action lists — these are the primary enforcement layer for local models.
- Do not add motivational language where a checklist or runtime gate is needed.
- Do not reference a tool that is not allowed in that stage's behavior (`src/runtime/stage-behavior.ts`).

### Domain Details
- **Stage → file map:**
  - `init.md` → init stage: initialize planner control before any project work
  - `intake.md` → intake stage: turn raw user request into approved goal; no source reading yet
  - `discovery.md` → discovery stage: AGENTS.md first, then project tree, then targeted file reads
  - `spec.md` → spec stage: author the checkable specification (REQ-n / non-goals / constraints / evidence-backed assumptions) and pass the deterministic spec_consistency gate; the model never hand-writes gate VRF
  - `planning.md` → planning stage: turn discovery context into ordered atomic tasks; no implementation
  - `execution.md` → execution stage: one task at a time via TDD → implement → contract check → refactor → merge
  - `tdd.md` → TDD step inside execution: failing test required before any production code
  - `refactor.md` → refactor step inside execution: structure/clarity improvements after production commit
  - `git.md` → git policy: raw shell git forbidden while plan is active; all git goes through planner tools
  - `git-commit.md` → commit message style guide; does not affect branch lifecycle
  - `finalize.md` → finalize stage: verify integrated result, write summary, compact context
  - `done.md` → done stage: present result, wait for user decision, export or return to planning
  - `recovery.md` → recovery stage: crash/conflict/branch recovery; entered when orchestrator detects inconsistent state
- **Who loads these:** `src/instructions/manager.ts` → `loadInstructionContent()` merges default + global append + project append → passed to model context by `src/instructions/routing.ts` → `src/runtime/orchestrator.ts`.
<!-- pi-code-planner:contracts:end -->

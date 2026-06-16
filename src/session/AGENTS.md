<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
Session domain: Pi session file creation, handoff between sessions, and resume candidate discovery. Bridges planner plan state with Pi's session storage format.

### Parent
- `../AGENTS.md`

### Child Index
- (none)

### Stable Contracts
- Session files use Pi's JSONL format with a typed header entry (`type: "session"`, `version: 3`).
- A handoff session file is the mechanism for carrying tool visibility state (`planner-tool-visibility`) across session boundaries.
- Resume candidates are found by scanning session files for the active plan ID.

### Read First
- `handoff.ts`

### Do Not Touch Unless
- Do not change the session header version without updating all readers and the Pi session format contract.
- Do not write session files without using `PlannerFs.writeTextAtomic` — non-atomic writes corrupt JSONL.

### Domain Details
- `handoff.ts` → `createPlannerHandoffSession()` writes a new JSONL session file with a typed header; `selectPlannerResumeSessionFile()` picks the best resume candidate (prefers one with messages) from a list supplied by the caller; `createPiSessionDir()` derives Pi's per-cwd session directory name; `removePlannerHandoffBootstrapFile()` deletes a bootstrap session file once it's no longer needed.
- `handoff.ts` also owns the prompt text injected into the new session: `buildPlannerHandoffPrompt()` (plan create), `buildPlannerImproveHandoffPrompt()` (discovery-first `/planner-improve` flow), `buildPlannerResumePrompt()` (resume) — these are the first instructions the model sees after the handoff.
- **Who calls this domain:** `index.ts` `/planner-create`, `/planner-improve`, and `/planner-resume` command handlers → `handoff.ts` to build/locate the session that carries plan state into the new Pi session.
- **Flow:** command handler → `session/handoff.ts` → writes new `.pi/sessions/<id>.jsonl` → Pi loads it as the active session → handoff prompt tells the model to call `planner_status` first.
<!-- pi-code-planner:contracts:end -->

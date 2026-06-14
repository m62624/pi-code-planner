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
- `handoff.ts` → `createHandoffSession()` writes a new JSONL session file; `findResumeSessionCandidates()` scans existing sessions to find one with the active plan's tool-visibility entry.
- **Who calls this domain:** `index.ts` `/planner-resume` command handler → `handoff.ts` to locate or create the session that carries plan state into the new Pi session.
- **Flow:** `/planner-resume` → `session/handoff.ts` → writes new `.pi/sessions/<id>.jsonl` → Pi loads it as the active session → tool visibility restored from JSONL entries.
<!-- pi-code-planner:contracts:end -->

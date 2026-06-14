<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
Project-local domain: writing and maintaining project-level gitignore rules for planner-managed paths (worktrees, storage dirs) so they don't appear in user's git status.

### Parent
- `../AGENTS.md`

### Child Index
- (none)

### Stable Contracts
- Planner appends to `.gitignore` at the project root; never rewrites the full file.
- If a rule already exists, the file is left unchanged (`action: "unchanged"`).
- Local exclusion (`.git/info/exclude`) is used as a fallback when the project's `.gitignore` should not be modified.

### Read First
- `gitignore.ts`

### Do Not Touch Unless
- Do not change the gitignore rule format without updating `PROJECT_WORKTREES_IGNORE_RULE` and related tests.
- Do not write to `.gitignore` with non-atomic I/O — concurrent writes corrupt the file.

### Domain Details
- `gitignore.ts` → `ensureProjectWorktreesIgnored()` appends to `.gitignore`; `ensureProjectWorktreesLocallyExcluded()` writes to `.git/info/exclude`.
- **Who calls this domain:** `worktree/manager.ts` → `gitignore.ts` after creating a worktree, to keep the worktree path out of user's git status.
- **Flow:** `worktree/manager.ts` → `project-local/gitignore.ts` → reads `.gitignore` → appends rule if missing → writes back atomically.
<!-- pi-code-planner:contracts:end -->

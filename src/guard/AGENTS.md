<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
Guard domain: tool call policy enforcement, git command interception, and project mutation safety checks. Acts as the permission layer between AI tool calls and the filesystem/git.

### Parent
- `../AGENTS.md`

### Child Index
- (none)

### Stable Contracts
- `tool-policy.ts` owns `ALL_PLANNER_TOOL_NAMES` — the authoritative list of planner-managed tool names used for tool visibility filtering.
- `git-watcher.ts` decides whether a raw `bash` git command is allowed given current plan state.
- `project-mutation.ts` decides whether a `write`/`edit`/`bash` call is allowed for a given path given stage/step behavior.

### Read First
- `tool-policy.ts`
- `git-watcher.ts`
- `project-mutation.ts`

### Do Not Touch Unless
- Do not add a planner tool without registering it in `ALL_PLANNER_TOOL_NAMES` in `tool-policy.ts`.
- Do not relax mutation guards without checking `stage-behavior.ts` — each stage has explicit allow/deny rules.

### Domain Details
- `tool-policy.ts` → exports `ALL_PLANNER_TOOL_NAMES` and `PLANNER_WRAPPER_TOOLS`; imported by `index.tool-visibility.ts` to build the hidden-tool set.
- `git-watcher.ts` → `checkRawGitAllowed()` is called in `index.ts` `before_tool_call` hook for every `bash` command; returns `{allow, reason}`.
- `project-mutation.ts` → `checkProjectMutation()` is called for `write`/`edit` tool calls; reads `getPlannerStageStepBehavior()` from `runtime/stage-behavior.ts` to determine current restrictions.
- **Flow:** `index.ts` before_tool_call → `guard/git-watcher.ts` or `guard/project-mutation.ts` → allow/deny with reason → Pi blocks or passes through.
<!-- pi-code-planner:contracts:end -->

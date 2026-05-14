# Settings

pi-planner uses JSON settings for machine-readable configuration and markdown
files for model-facing instructions.

## Locations

Global extension settings:

```text
getAgentDir()/extensions/pi-planner/settings.json
```

Project override settings:

```text
<project>/.pi/extensions/pi-planner/settings.json
```

Project settings override global settings. Missing project fields inherit from
global settings and built-in defaults.

## Editable Fields

```json
{
  "version": 1,
  "instructions": {
    "discovery": "instructions/discovery.md",
    "plan": "instructions/plan.md",
    "work_item": "instructions/work_item.md",
    "refactor": "instructions/refactor.md",
    "api_check": "instructions/api_check.md",
    "documentation": "instructions/documentation.md",
    "compact": "instructions/compact.md",
    "commit_style": "instructions/commit_style.md"
  },
  "refactor": {
    "maxIterations": 3,
    "compactAfterEachIteration": true
  },
  "git": {
    "shellToolNames": ["bash"],
    "blockedCommitPatterns": ["\\bgit\\s+commit\\b"],
    "blockedDangerousPatterns": [
      "\\bgit\\s+reset\\b",
      "\\bgit\\s+rebase\\b",
      "\\bgit\\s+merge\\b",
      "\\bgit\\s+checkout\\b",
      "\\bgit\\s+switch\\b",
      "\\bgit\\s+branch\\s+-D\\b",
      "\\bgit\\s+clean\\b"
    ],
    "branchNaming": {
      "plan": "planner/{planId}/main",
      "child": "planner/{planId}/work/{workItemId}",
      "experiment": "planner/{planId}/experiment/{workItemId}/{attemptId}"
    },
    "deleteChildBranch": true,
    "archiveChildPlans": false
  },
  "verificationCommands": []
}
```

## Instructions

`instructions` maps instruction names to markdown files.

Relative paths are resolved from the owning settings directory:

- global paths are relative to `getAgentDir()/extensions/pi-planner`
- project paths are relative to `<project>/.pi/extensions/pi-planner`

Project markdown files win over global markdown files when they exist at the
same configured path.

## Refactor

`refactor.maxIterations` controls the default maximum number of refactor
iterations.

`refactor.compactAfterEachIteration` controls whether compaction should happen
after each finished iteration.

## Git Guardrails

`git.shellToolNames` lists tool names that should be treated as shell execution
tools for git command interception.

`git.blockedCommitPatterns` contains regular expressions for direct commit
commands that must be blocked while a plan is active.

`git.blockedDangerousPatterns` contains regular expressions for dangerous git
commands that must be routed through planner tools instead of direct shell calls.

## Branch Naming

`git.branchNaming` is a machine-readable contract. It must stay in JSON settings,
not markdown.

Supported placeholders:

- `{planId}`
- `{workItemId}`
- `{attemptId}`

Required placeholders:

- `plan` requires `{planId}`
- `child` requires `{planId}` and `{workItemId}`
- `experiment` requires `{planId}`, `{workItemId}`, and `{attemptId}`

The rendered branch names are validated by code. The validator rejects invalid
git branch names and prefix conflicts such as:

```text
planner/{planId}
planner/{planId}/work/{workItemId}
```

That layout is unsafe because Git cannot store both `planner/my-plan` and
`planner/my-plan/work/parser` as branch refs.

## Verification Commands

`verificationCommands` is reserved for project verification commands. These will
be used by planner tools before finishing work items.

## What Belongs In Markdown

Use markdown for model-facing instruction text:

- commit message style
- discovery checklists
- TDD workflow instructions
- recovery explanations
- compact prompts
- documentation style
- user question templates

## What Must Stay In JSON

Use JSON settings for values that must be parsed and validated by code:

- branch naming templates
- shell tool names
- blocked git command patterns
- dangerous operation guardrails
- verification command lists

Runtime state does not belong in settings. Active plan ids, expected branch,
expected commit, pending operations, and branch registry are stored in
`state.json`.


# Settings

pi-planner uses JSON settings for machine-readable configuration and markdown
files for model-facing instructions.

This document describes the settings contract. Runtime state is documented in
[Runtime State](runtime-state.md). Git behavior is documented in
[Git Safety](git-safety.md).

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

## Generated Files

On initialization, the extension ensures global files exist:

```text
getAgentDir()/extensions/pi-planner/settings.json
getAgentDir()/extensions/pi-planner/state.json
getAgentDir()/extensions/pi-planner/instructions/*.md
```

`settings.json` is user-editable configuration. `state.json` is runtime state and
must not be edited as settings.

## Editable Settings

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
  "memory": {
    "autoDirtyTracking": true,
    "dirtyPathIgnorePrefixes": [
      ".git/",
      ".pi/extensions/pi-planner/",
      "node_modules/",
      "dist/",
      "coverage/",
      ".turbo/"
    ],
    "dirtyPolicy": {
      "blockCompact": true,
      "blockWorkItemCommit": true,
      "blockSignatureRefreshExit": true
    }
  },
  "verificationCommands": []
}
```

## Field Summary

| Field | Purpose | Details |
| --- | --- | --- |
| `version` | Settings schema version. | Currently `1`. |
| `instructions` | Names of model-facing markdown files. | See [Instructions](#instructions). |
| `refactor` | Basic refactor-loop defaults. | See [Refactor](#refactor). |
| `git` | Git safety and branch configuration. | See [Git Safety](git-safety.md). |
| `memory` | Project memory safety configuration. | See [Memory](#memory). |
| `verificationCommands` | Project checks to run before finishing work. | Reserved for future planner workflow. |

## Instructions

`instructions` maps instruction names to markdown files.

Supported instruction names:

- `discovery`
- `plan`
- `work_item`
- `refactor`
- `api_check`
- `documentation`
- `compact`
- `commit_style`

Relative paths are resolved from the owning settings directory:

- global paths are relative to `getAgentDir()/extensions/pi-planner`
- project paths are relative to `<project>/.pi/extensions/pi-planner`

Project markdown files win over global markdown files when they exist at the
same configured path.

Use [Instruction Sections](instruction-sections.md) when one markdown file needs
multiple operation-specific prompts.

## Refactor

`refactor.maxIterations` controls the default maximum number of refactor
iterations.

`refactor.compactAfterEachIteration` controls whether compaction should happen
after each finished iteration.

The future tournament workflow will add richer TDD/refactor settings. The target
workflow is documented in [Workflow](workflow.md).

## Git Settings Summary

`git.shellToolNames` lists shell-like tools that should be checked for direct git
commands while a plan is active.

`git.blockedCommitPatterns` contains regular expressions for direct commit
commands that must be blocked while a plan is active.

`git.blockedDangerousPatterns` contains regular expressions for dangerous git
commands that must be routed through planner tools.

`git.branchNaming` is the branch naming contract. It is parsed and validated by
code. See [Git Safety](git-safety.md#branch-naming).

`git.deleteChildBranch` and `git.archiveChildPlans` are reserved settings for
future cleanup behavior.

## Memory

`memory.autoDirtyTracking` controls whether active planner sessions mark project
memory dirty from git status. This is enabled by default so changes made through
shell commands, formatters, or unknown edit tools still invalidate compressed
memory before commit/compact boundaries.

`memory.dirtyPathIgnorePrefixes` lists repo-relative prefixes ignored by the
automatic dirty tracker. Use it for generated output or planner-owned metadata
that should not require `signature_refresh`.

`memory.dirtyPolicy` controls which public operations are blocked while project
memory has dirty files.

Defaults:

```json
{
  "memory": {
    "autoDirtyTracking": true,
    "dirtyPathIgnorePrefixes": [
      ".git/",
      ".pi/extensions/pi-planner/",
      "node_modules/",
      "dist/",
      "coverage/",
      ".turbo/"
    ],
    "dirtyPolicy": {
      "blockCompact": true,
      "blockWorkItemCommit": true,
      "blockSignatureRefreshExit": true
    }
  }
}
```

Fields:

- `autoDirtyTracking`: when true, runtime status and protected public tools sync
  dirty memory from `git status` while a plan is active.
- `dirtyPathIgnorePrefixes`: repo-relative prefixes filtered out of automatic
  dirty tracking.
- `blockCompact`: blocks compact tools until dirty memory is refreshed.
- `blockWorkItemCommit`: blocks `planner_finish_work_item` while memory is dirty.
- `blockSignatureRefreshExit`: blocks moving from `signature_refresh` to
  `work_item_compact_required` while memory is dirty.

These flags are enabled by default because compact boundaries are where the local
model must resume from accurate compressed memory.

## What Belongs In Markdown

Use markdown for model-facing instruction text:

- commit message style
- discovery checklists
- TDD workflow instructions
- recovery explanations
- compact prompts
- documentation style
- user question templates
- experiment selection reasoning

## What Must Stay In JSON

Use JSON settings for values that must be parsed and validated by code:

- branch naming templates
- shell tool names
- blocked git command patterns
- dangerous operation guardrails
- memory dirty policy flags
- verification command lists
- future numeric selection/scoring settings

## Settings API

See [API Inventory](api.md#settings-layer) for current TypeScript APIs.

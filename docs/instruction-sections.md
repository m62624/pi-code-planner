# Instruction Sections

Instruction markdown files can be used as complete prompts or split into named
sections. The parser is generic. Git, TDD, planning, compaction, API checks, and
documentation prompts should all use the same section rules.

## Source And Runtime Layout

Bundled markdown templates live in:

```text
src/instructions/markdown/*.md
```

Generated user-editable instruction files live in:

```text
getAgentDir()/extensions/pi-planner/instructions/*.md
<project>/.pi/extensions/pi-planner/instructions/*.md
```

Runtime paths are intentionally separate from bundled source templates.

## Section Syntax

A section starts with a markdown heading. The section body continues until the
next heading with the same or higher level.

```md
# Git Instructions

## commit.work_item

Instructions for a work item commit.

### format

Nested headings stay inside the `commit.work_item` section.

## recovery.external_commit

Instructions for external commit recovery.

## details

Optional user-specific additions. Callers can append this section to a selected
operation section.
```

Section names are matched case-insensitively after trimming whitespace.

## Missing Sections

Callers choose whether a section is required:

- required missing section: throw an error
- optional missing section: return `null`

## Details Section

`getInstructionSectionContent` can append a `details` section to the selected
section. This is useful for project-specific additions that should apply to many
operations in the same instruction file.

## API

See [API Inventory](api.md#instruction-layer).


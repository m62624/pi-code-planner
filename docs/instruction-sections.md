# Instruction Sections

Instruction files can be used as complete markdown prompts or split into named
sections. A section starts with a markdown heading. The section body continues
until the next heading with the same or higher level.

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

Section names are matched case-insensitively after trimming whitespace. A missing
required section is an error. A caller can request an optional section and receive
`null` when it is absent.

The parser is generic. Git, TDD, planning, compaction, API checks, and
documentation prompts should all use the same section rules.


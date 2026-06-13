<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
Bundled model-facing instruction domain. These markdown files teach local models how to execute each planner stage after sync into planner storage.

### Parent
- `../AGENTS.md`

### Child Index
- (none)

### Stable Contracts
- Every default instruction must be substantive and include auto-compact recovery guidance.
- Instructions should describe exact tools, artifacts, gates, and forbidden actions for local models.
- Runtime gates in code are stronger than instructions; instruction changes should not be the only enforcement for critical behavior.
- Every stage instruction should keep an evidence discipline section or equivalent concrete checklist. Do not replace proof requirements with motivational confidence language.

### Read First
- `defaults/discovery.md`
- `defaults/execution.md`
- `defaults/finalize.md`
- `defaults/done.md`
- `../src/instructions/manager.ts`

### Do Not Touch Unless
- Do not add vague motivational instructions where a concrete checklist or runtime gate is needed.
- Do not mention tools that are not allowed by the matching stage behavior.

### Domain Details
- `syncBundledInstructionFiles` copies defaults into extension storage without overwriting append files.
- Append files are user/project customization points and must remain untouched by default sync.
<!-- pi-code-planner:contracts:end -->

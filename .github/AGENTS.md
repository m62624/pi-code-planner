<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
GitHub automation domain for CI, labeler, release candidate flow, npm publishing, and generated release notes.

### Parent
- `../AGENTS.md`

### Child Index
- (none)

### Stable Contracts
- CI must run check, build, test, and npm pack dry-run for package integrity.
- Release publishing uses npm/GitHub workflow configuration; avoid adding Rust or bench steps to this TypeScript package.
- Generated release notes depend on labels and GitHub release configuration.

### Read First
- `workflows/ci.yml`
- `workflows/release.yml`
- `workflows/labeler.yml`
- `release.yml`

### Do Not Touch Unless
- Do not change publish permissions, package provenance, or branch protection assumptions without updating `RELEASING.md`.
- Do not add secrets-based npm publish flow when trusted publishing is intended.

### Domain Details
- The package is published as `pi-code-planner`.
- Labeler and release notes are process tooling, not runtime behavior.
<!-- pi-code-planner:contracts:end -->

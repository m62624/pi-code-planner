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
- `workflows/ci.yml` → runs on push/PR to `main` touching `src/**`, `instructions/**`, or config files; runs `npm run check` (biome), `npm run build` (tsc), `npm test` (vitest), and `npm pack --dry-run`. Also callable via `workflow_call` with a `ref` input (used by `release.yml`'s `tests` job) and via manual `workflow_dispatch`.
- `workflows/release.yml` → triggered by pushing a `pin/v*` tag. **Flow:** `prepare` (parse version from tag, create `rc/vX.Y.Z` branch, bump `package.json`/`package-lock.json`, force-push) → `tests` (calls `ci.yml` against the RC branch) → `publish` (npm publish via trusted OIDC publishing, `id-token: write`, skips if version already on npm) → `release` (re-tag `vX.Y.Z`, open/find a sync PR from the RC branch back to `main`, generate release notes via `release.yml` config, create a draft GitHub release).
- `release.yml` (repo-root, not a workflow) → GitHub auto-generated-release-notes config; buckets PRs into changelog categories by label (breaking/feat/fix/refactor/performance/docs/chore+ci+style+test/build/other), excludes `skip-changelog` label and bot authors. Consumed by the `release` job's "Generate Release Notes" step in `workflows/release.yml`.
- `workflows/labeler.yml` → on PR opened/edited/synchronized, parses the PR title for a Conventional-Commits-style prefix (`feat:`, `fix:`, `refactor:`, etc.) and applies/creates matching labels; also adds a `breaking` label when the prefix has a `!`. These are the same label names `release.yml`'s changelog categories key off of — renaming a label here without updating `release.yml` silently drops PRs into "Other Changes".
- The package is published as `pi-code-planner`.
- Labeler and release notes are process tooling, not runtime behavior.
<!-- pi-code-planner:contracts:end -->

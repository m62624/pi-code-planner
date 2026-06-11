# Releasing

Releases use the same pin-tag flow as the reference workflow, adapted for npm.

## Prerequisites

- Configure npm Trusted Publishing for this package:
  - Publisher: GitHub Actions.
  - Organization or user: `m62624`.
  - Repository: `pi-planner`.
  - Workflow filename: `release.yml`.
  - Allowed action: `npm publish`.
- Use conventional PR titles or commit messages so labels and release notes stay useful.
- Keep `package-lock.json` committed; CI uses `npm ci`.

## Flow

1. Create and push a pin tag:

   ```bash
   git tag pin/v0.1.0
   git push origin pin/v0.1.0
   ```

2. GitHub Actions creates `rc/v0.1.0`, updates `package.json` and `package-lock.json`, and deletes the pin tag.
3. CI runs lint, typecheck, tests, and `npm pack --dry-run`.
4. The workflow publishes to npm through Trusted Publishing. No long-lived npm token is stored in GitHub.
5. The workflow creates the final `v0.1.0` tag, opens a sync PR back to `main`, and creates a draft GitHub release.

## Pi Install

After npm publish:

```bash
pi install npm:pi-code-planner@0.1.0
```

For a local development run:

```bash
pi -e ./src/index.ts
```

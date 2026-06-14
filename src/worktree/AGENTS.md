<!-- pi-code-planner:contracts:start -->
## Planner Contracts

### Purpose
Worktree domain: git worktree creation/removal for plan isolation, path resolution, and ensuring worktree directories are gitignored from the project.

### Parent
- `../AGENTS.md`

### Child Index
- (none)

### Stable Contracts
- Each plan gets one worktree at `.pi/pi-code-planner/worktrees/<planId>/`.
- Worktree path is stored in `PlanStateRecord.worktreePath`; once set it does not change for the lifetime of the plan.
- Worktrees are registered in `storage/worktree-index.ts` so the extension can recover when Pi's cwd is the worktree.

### Read First
- `manager.ts`
- `paths.ts`

### Do Not Touch Unless
- Do not remove a worktree without first removing it from `storage/worktree-index.ts`.
- Do not create worktrees outside the `.pi/pi-code-planner/worktrees/` subtree — `guard/project-mutation.ts` depends on this path contract to allow writes inside worktrees.

### Domain Details
- `manager.ts` → `createPlanWorktree()` calls `git/node-runner.ts` worktree add + `project-local/gitignore.ts` to exclude the path; `removePlanWorktree()` calls worktree remove.
- `paths.ts` → `isProjectLocalWorktreePath()` checks if a path is inside the worktrees dir; used by `guard/project-mutation.ts` to allow mutations inside the plan worktree.
- **Who calls this domain:** `runtime/workflow-tools.ts` → `worktree/manager.ts` when creating or finishing a plan that uses worktree isolation.
- **Flow:** `planner_create_plan` (worktree mode) → `worktree/manager.ts` → `git/node-runner.ts` + `project-local/gitignore.ts` → worktree ready; path stored in state → `storage/worktree-index.ts` registers mapping.
<!-- pi-code-planner:contracts:end -->
